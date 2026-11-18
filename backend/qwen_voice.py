"""Local Qwen3-TTS: one cancellable utterance, a fixed synthetic voice, no job queue.

The isolated worker keeps MLX/Transformers dependencies out of the ASR runtime.
Its stdin/stdout protocol is private to this process; speech is never written to disk.
"""
from __future__ import annotations

import atexit
import base64
from collections import OrderedDict
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import queue
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
VOICE = "qwen-girl-curious"
PROFILE = ROOT / "assets/voice" / VOICE


class SpeechCancelled(RuntimeError):
    pass


class SpeechBusy(RuntimeError):
    pass


def backend_name(value=None):
    selected = (value or os.environ.get("DUCK_TTS_BACKEND", "auto")).strip().lower()
    if selected == "auto":
        return "mlx" if sys.platform == "darwin" and platform.machine() == "arm64" else "gguf"
    if selected == "cuda":
        selected = "bf16"  # Preserve the previous backend's explicit name.
    if selected not in ("mlx", "gguf", "bf16"):
        raise ValueError("DUCK_TTS_BACKEND 应为 auto、mlx、gguf 或 bf16。")
    return selected


def worker_python(kind=None):
    bundled = ROOT / ".runtime/python" / ("python.exe" if os.name == "nt" else "bin/python3.12")
    return bundled if bundled.is_file() else ROOT / ".venv-tts" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def model_directory(model_root, kind=None):
    names = {"mlx": "qwen3-tts-base-mlx-4bit", "bf16": "qwen3-tts-base-cuda", "gguf": "qwen3-tts-base-gguf"}
    return Path(model_root) / names[backend_name(kind)]


class QwenSpeech:
    def __init__(self, model_root, backend=None):
        self.model_root = Path(model_root)
        self.backend = backend_name(backend)
        self._operation = threading.Lock()
        self._state = threading.RLock()
        self._process = None
        self._gguf = None
        self._active = None
        self._loaded = False
        self._warming = False
        self._warm_done = threading.Event()
        self._cancelled = OrderedDict()
        self._cache = OrderedDict()
        self._cache_bytes = 0
        self._error = None
        self.last_metrics = {}
        atexit.register(self.close)

    def installed(self):
        directory = model_directory(self.model_root, self.backend)
        if self.backend == "gguf":
            from .qwen_gguf import installed
            return installed(directory) and all((PROFILE / p).is_file() for p in ("profile.json", "reference.wav"))
        return worker_python().is_file() and all((directory / p).is_file() for p in (
            "config.json", "model.safetensors", "tokenizer_config.json", "vocab.json",
            "merges.txt", "speech_tokenizer/model.safetensors")) and all(
                (PROFILE / p).is_file() for p in ("profile.json", "reference.wav"))

    def status(self):
        with self._state:
            return {"installed": self.installed(), "loaded": bool(self._loaded and self._process and self._process.poll() is None),
                    "warming": self._warming, "error": self._error,
                    "backend": self.backend, "busy": self._active is not None}

    def _stop_worker(self):
        process, self._process = self._process, None
        self._gguf = None
        self._loaded = False
        if process is not None:
            if process.poll() is None:
                # llama-server drains active inference on SIGTERM. It owns no
                # persistent state, so stop immediately when speech is cancelled.
                process.kill() if self.backend == "gguf" else process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe:
                    pipe.close()

    def close(self):
        with self._state:
            self._stop_worker()

    def cancel(self, request_id):
        # A short tombstone also handles cancel arriving before its POST /speech.
        with self._state:
            self._cancelled[request_id] = time.monotonic()
            while self._cancelled and (len(self._cancelled) > 512 or next(iter(self._cancelled.values())) < time.monotonic() - 300):
                self._cancelled.popitem(last=False)
            active = self._active == request_id
            if active:
                self._stop_worker()
            return active

    def _receive(self, messages, process, request_id, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._state:
                if request_id in self._cancelled:
                    raise SpeechCancelled("这次播音已停止。")
            try:
                result = messages.get(timeout=.1)
            except queue.Empty:
                if process.poll() is not None:
                    raise RuntimeError("本地语音进程已退出，请重听；仍失败时重新运行语音准备。")
                continue
            with self._state:
                if request_id in self._cancelled:
                    raise SpeechCancelled("这次播音已停止。")
            if result is None:
                raise RuntimeError("本地语音进程已退出，请重听。")
            if "error" in result:
                raise RuntimeError(result["error"])
            return result
        raise RuntimeError("本地声音准备超时，请重听或请老师检查设备。")

    def _ensure_worker(self, request_id=None):
        if self.backend == "gguf":
            return self._ensure_gguf(request_id)
        with self._state:
            if request_id in self._cancelled:
                raise SpeechCancelled("这次播音已停止。")
            if self._process is not None and self._process.poll() is None and self._loaded:
                return self._process, self._messages
            self._stop_worker()
            if not self.installed():
                raise RuntimeError("好奇女孩语音未准备好，请运行项目语音准备脚本。")
            env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                       HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false",
                       PYTHONUNBUFFERED="1", PYTHONNOUSERSITE="1")
            env["DUCK_TTS_BACKEND"] = self.backend
            packages = ROOT / ".runtime/tts-packages"
            env.pop("PYTHONPATH", None)
            if packages.is_dir():
                env["PYTHONPATH"] = str(packages)
            process = self._process = subprocess.Popen(
                [str(worker_python()), str(Path(__file__).resolve()), "--worker", str(model_directory(self.model_root, self.backend))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, text=True, encoding="utf-8", env=env,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            messages = self._messages = queue.Queue()

            def read():
                try:
                    for line in process.stdout:
                        try:
                            messages.put(json.loads(line))
                        except ValueError:
                            pass  # Third-party diagnostics must not break the protocol.
                except (OSError, ValueError):
                    pass
                finally:
                    messages.put(None)
            threading.Thread(target=read, daemon=True).start()
        result = self._receive(messages, process, request_id, timeout=120)
        if not result.get("ready"):
            raise RuntimeError("本地语音未完成加载。")
        with self._state:
            if request_id in self._cancelled or self._process is not process:
                raise SpeechCancelled("这次播音已停止。")
            self._loaded = True
            self._error = None
        return process, messages

    def _ensure_gguf(self, request_id):
        from .qwen_gguf import GGUFEngine
        with self._state:
            if request_id in self._cancelled:
                raise SpeechCancelled("这次播音已停止。")
            if self._process is not None and self._process.poll() is None and self._loaded:
                return self._gguf, None
            self._stop_worker()
            if not self.installed():
                raise RuntimeError("GGUF 好奇女孩未准备好，请运行项目语音准备脚本。")
            engine = self._gguf = GGUFEngine(model_directory(self.model_root, self.backend), PROFILE)
            self._process = engine.start()

        def check_cancel():
            with self._state:
                if request_id in self._cancelled or self._process is not engine.process:
                    raise SpeechCancelled("这次播音已停止。")

        engine.wait_ready(check_cancel)
        with self._state:
            check_cancel()
            self._loaded = True
            self._error = None
        return engine, None

    def warmup(self):
        if not self._operation.acquire(blocking=False):
            return
        self._warming = True
        self._warm_done.clear()
        try:
            self._ensure_worker()
        except Exception as exc:
            self._error = str(exc)
            self.close()
            raise
        finally:
            self._warming = False
            self._warm_done.set()
            self._operation.release()

    def speak(self, text, speed=1.0, request_id=None, *, use_cache=True):
        request_id = request_id or str(uuid.uuid4())
        # Static, packaged operation prompts need no model slot at all.
        fixed = self._fixed_prompt(text, speed)
        with self._state:
            if request_id in self._cancelled:
                raise SpeechCancelled("这次播音已停止。")
            key = (text, speed)
            if fixed is not None:
                return fixed
            if use_cache and key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        if self._warming:
            self._warm_done.wait(timeout=120)
        if not self._operation.acquire(blocking=False):
            raise SpeechBusy("另一个页面正在准备声音，请稍后重听。")
        started = time.monotonic()
        try:
            with self._state:
                if request_id in self._cancelled:
                    raise SpeechCancelled("这次播音已停止。")
                self._active = request_id
            load_started = time.monotonic()
            process, messages = self._ensure_worker(request_id)
            load_ms = round((time.monotonic() - load_started) * 1000)
            if self.backend == "gguf":
                data, metrics = process.synthesize(text, speed, render_audio)
            else:
                process.stdin.write(json.dumps({"text": text, "speed": speed}, ensure_ascii=False) + "\n")
                process.stdin.flush()
                result = self._receive(messages, process, request_id)
                data = base64.b64decode(result["audio"], validate=True)
                metrics = result["metrics"]
            with self._state:
                if request_id in self._cancelled:
                    raise SpeechCancelled("这次播音已停止。")
                if use_cache and len(data) <= 4 * 1024 * 1024:
                    self._cache[key] = data
                    self._cache_bytes += len(data)
                    while len(self._cache) > 48 or self._cache_bytes > 16 * 1024 * 1024:
                        _, removed = self._cache.popitem(last=False)
                        self._cache_bytes -= len(removed)
                self.last_metrics = dict(metrics, loadMs=load_ms, cacheHit=False,
                                         totalMs=round((time.monotonic() - started) * 1000))
                self._error = None
            print(json.dumps({"event": "local_tts", "voice": VOICE, **self.last_metrics}), file=sys.stderr, flush=True)
            return data
        except SpeechCancelled:
            raise
        except Exception:
            with self._state:
                cancelled = request_id in self._cancelled
            self.close()
            if cancelled:
                raise SpeechCancelled("这次播音已停止。") from None
            raise
        finally:
            with self._state:
                self._active = None
            self._operation.release()

    def _fixed_prompt(self, text, speed):
        manifest = ROOT / "web/assets/voice" / VOICE / "manifest.json"
        if not manifest.is_file():
            return None
        entries = json.loads(manifest.read_text(encoding="utf-8")).get("guides", [])
        item = next((p for p in entries if p["text"] == text), None)
        if item:
            path = manifest.parent / item["file"]
            if path.is_file():
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() == item["sha256"]:
                    if speed != 1.0:
                        import imageio_ffmpeg
                        data = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
                            "-i", "pipe:0", "-af", f"atempo={speed:.6f}", "-f", "wav", "-c:a", "pcm_s16le", "pipe:1"],
                            input=data, capture_output=True, timeout=10, check=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0).stdout
                    return data
        return None


def render_audio(samples, sample_rate, text, speed, profile):
    """Exactly the audition's whole-waveform, pitch-preserving pace + loudness."""
    import imageio_ffmpeg
    import numpy as np
    import pyloudnorm as pyln
    import re
    import soundfile as sf
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not len(samples) or not np.isfinite(samples).all():
        raise RuntimeError("本地播音没有生成有效声音，请重听。")
    raw = io.BytesIO()
    sf.write(raw, samples, sample_rate, format="WAV", subtype="PCM_16")
    count = len(re.findall(r"[\u4e00-\u9fff]", text))
    factor = max(.75, min(1.4, profile["hanziPerSecond"] * speed * len(samples) / sample_rate / count)) if count else speed
    processed = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", "pipe:0", "-af", f"atempo={factor:.10f}", "-f", "wav", "-c:a", "pcm_s16le", "pipe:1"],
        input=raw.getvalue(), capture_output=True, timeout=30, check=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    audio, sr = sf.read(io.BytesIO(processed.stdout), dtype="float32")
    meter = pyln.Meter(sr)
    if len(audio) >= .4 * sr:
        loudness = float(meter.integrated_loudness(audio))
        if np.isfinite(loudness):
            gain = min(10 ** ((profile["lufs"] - loudness) / 20), .98 / max(float(np.max(np.abs(audio))), 1e-9))
            audio *= gain
    out = io.BytesIO()
    sf.write(out, audio, sr, format="WAV", subtype="PCM_16")
    return out.getvalue(), {"audioMs": round(len(audio) / sr * 1000), "tempoFactor": round(factor, 4)}


def worker(model_dir):
    # All third-party stdout goes to stderr; only protocol JSON is on stdout.
    from contextlib import redirect_stdout
    protocol = sys.stdout
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    profile = json.loads((PROFILE / "profile.json").read_text(encoding="utf-8"))
    reference = PROFILE / "reference.wav"
    if hashlib.sha256(reference.read_bytes()).hexdigest() != profile["referenceSha256"]:
        raise RuntimeError("音色参考文件校验失败，请重新准备语音。")
    with redirect_stdout(sys.stderr):
        if backend_name() == "mlx":
            import mlx.core as mx
            import numpy as np
            from mlx_audio.tts.utils import load_model
            mx.set_memory_limit(5_500_000_000)
            mx.set_cache_limit(128_000_000)
            engine = load_model(Path(model_dir))
            mx.synchronize()
        else:
            import torch
            from qwen_tts import Qwen3TTSModel
            if not torch.cuda.is_available():
                raise RuntimeError("本版 Windows 语音需要 NVIDIA 显卡和可用的 CUDA 驱动。")
            engine = Qwen3TTSModel.from_pretrained(model_dir, device_map="cuda:0", dtype=torch.bfloat16,
                                                  attn_implementation="sdpa", local_files_only=True)
            prompt = engine.create_voice_clone_prompt(ref_audio=str(reference), ref_text=profile["referenceText"], x_vector_only_mode=False)
    print(json.dumps({"ready": True}), file=protocol, flush=True)
    for line in sys.stdin:
        started = time.monotonic()
        try:
            value = json.loads(line)
            text, speed = value["text"], value["speed"]
            limit = min(16000, max(768, len(text) * 8))
            with redirect_stdout(sys.stderr):
                if backend_name() == "mlx":
                    mx.random.seed(profile["seed"])
                    chunks, tokens = [], 0
                    for chunk in engine.generate(text=text, ref_audio=str(reference), ref_text=profile["referenceText"],
                            lang_code="Chinese", temperature=.9, top_k=50, top_p=1., max_tokens=limit,
                            repetition_penalty=1.5, stream=True, streaming_interval=2., verbose=False):
                        chunks.append(np.asarray(chunk.audio.astype(mx.float32)).reshape(-1))
                        sr = chunk.sample_rate
                        tokens += chunk.token_count
                    mx.synchronize()
                    if tokens >= limit:
                        raise RuntimeError("声音未完整生成，请重听；长日记请老师检查。")
                    samples = np.concatenate(chunks)
                    mx.clear_cache()
                else:
                    torch.manual_seed(profile["seed"])
                    with torch.inference_mode():
                        wavs, sr = engine.generate_voice_clone(text=text, language="Chinese", voice_clone_prompt=prompt,
                            temperature=.9, top_k=50, top_p=1., repetition_penalty=1.5, max_new_tokens=limit)
                    samples = wavs[0]
                synthesis_ms = round((time.monotonic() - started) * 1000)
                t = time.monotonic()
                audio, metrics = render_audio(samples, sr, text, speed, profile)
                metrics.update(synthesisMs=synthesis_ms, postprocessMs=round((time.monotonic() - t) * 1000),
                               rawAudioMs=round(len(samples) / sr * 1000), backend=backend_name())
            print(json.dumps({"audio": base64.b64encode(audio).decode("ascii"), "metrics": metrics}), file=protocol, flush=True)
        except Exception as exc:
            print("Qwen worker: " + type(exc).__name__, file=sys.stderr, flush=True)
            print(json.dumps({"error": str(exc) if isinstance(exc, RuntimeError) else "本地声音生成失败，请重听。"}), file=protocol, flush=True)


if __name__ == "__main__":
    try:
        worker(sys.argv[2])
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
