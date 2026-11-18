"""Private, GPU-only llama.cpp transport for the fixed Qwen voice.

The application owns this one child process. No speech files, external requests,
prompt logs, or persistent service are created by this adapter.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

BUILD = "b12503"
MODEL = "Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf"
PROJECTOR = "mmproj-Qwen3-TTS-Base-ICL-bf16.gguf"
MODEL_BYTES = 1035965280
PROJECTOR_BYTES = 840287936


def binary_path(model_root):
    return Path(model_root) / f"llama-{BUILD}" / ("llama-server.exe" if os.name == "nt" else "llama-server")


def installed(model_dir):
    directory = Path(model_dir)
    return (binary_path(directory.parent).is_file()
            and all(importlib.util.find_spec(name) is not None for name in ("numpy", "soundfile", "pyloudnorm", "imageio_ffmpeg"))
            and all((directory / name).is_file() and (directory / name).stat().st_size == size
                    for name, size in ((MODEL, MODEL_BYTES), (PROJECTOR, PROJECTOR_BYTES))))


class GGUFEngine:
    def __init__(self, model_dir, profile_path):
        self.model_dir = Path(model_dir)
        self.profile = json.loads((profile_path / "profile.json").read_text(encoding="utf-8"))
        reference = (profile_path / "reference.wav").read_bytes()
        if hashlib.sha256(reference).hexdigest() != self.profile["referenceSha256"]:
            raise RuntimeError("音色参考文件校验失败，请重新准备语音。")
        self.reference = base64.b64encode(reference).decode("ascii")
        self.device = "CUDA0" if os.name == "nt" else "MTL0"
        self.key = uuid.uuid4().hex
        self.process = None
        self.gpu_layers = None
        self.projector_gpu = False
        self.reference_fallback = False
        self.truncated = False
        # Loopback traffic must not inherit an HTTP proxy configured by the user.
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def start(self):
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        command = [str(binary_path(self.model_dir.parent)),
                   "-m", str(self.model_dir / MODEL), "-mm", str(self.model_dir / PROJECTOR),
                   "--host", "127.0.0.1", "--port", str(port), "--device", self.device,
                   "-ngl", "99", "--fit", "off", "-np", "1", "-c", "4096",
                   "--tts-lang", "zh", "--min-p", "0", "--no-warmup", "--no-webui", "-lv", "4"]
        # Strip llama CLI overrides so the packaged settings are reproducible.
        env = {k: v for k, v in os.environ.items() if not k.startswith("LLAMA_")}
        env.update(LLAMA_API_KEY=self.key, HF_HUB_OFFLINE="1")
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        threading.Thread(target=self._read_diagnostics, daemon=True).start()
        return self.process

    def _read_diagnostics(self):
        # Keep only numeric/device facts. Never persist or forward engine prompt logs.
        try:
            for line in self.process.stderr:
                match = re.search(r"offloaded (\d+)/(\d+) layers to GPU", line)
                if match:
                    self.gpu_layers = (int(match[1]), int(match[2]))
                if "mtmd_backends" in line and f"using {self.device} backend" in line:
                    self.projector_gpu = True
                if "no reference codes" in line:
                    self.reference_fallback = True
                if re.search(r"truncated\s*=\s*1\b", line):
                    self.truncated = True
        except (OSError, ValueError):
            pass

    def _request(self, path, payload=None, timeout=1):
        request = urllib.request.Request(self.url + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None,
            headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        return self.http.open(request, timeout=timeout)

    def wait_ready(self, check_cancel):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            check_cancel()
            if self.process.poll() is not None:
                raise RuntimeError("GGUF 加载失败，请检查显卡驱动、CUDA 运行库与模型校验；不会回退到 CPU。")
            try:
                with self._request("/health") as response:
                    ready = response.status == 200
                if ready and self.gpu_layers and self.projector_gpu:
                    if self.gpu_layers[0] != self.gpu_layers[1]:
                        raise RuntimeError("GGUF 未完整加载到显卡，请释放显存后重试。")
                    return
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(.1)
        raise RuntimeError("GGUF 未在两分钟内完成 GPU 加载，请检查显卡驱动、模型和运行库。")

    def synthesize(self, text, speed, render_audio):
        import soundfile as sf
        limit = min(16000, max(768, len(text) * 8))
        self.reference_fallback = self.truncated = False
        payload = {"input": text, "lang": "zh", "speaker_ref_b64": self.reference,
                   "speaker_ref_text": self.profile["referenceText"], "top_k": 50, "top_p": 1.,
                   "temperature": .9, "repeat_penalty": 1.5, "seed": self.profile["seed"],
                   "n_predict": limit, "response_format": "wav", "stream": False}
        started = time.monotonic()
        try:
            with self._request("/tts", payload, timeout=180) as response:
                raw = response.read(64 * 1024 * 1024 + 1)
            if len(raw) > 64 * 1024 * 1024:
                raise RuntimeError("生成的声音过长，请缩短朗读内容。")
        except (OSError, urllib.error.URLError) as exc:
            raise RuntimeError("GGUF 声音生成未完成，请重听；若持续失败，请检查显存或缩短朗读内容。") from exc
        samples, sr = sf.read(io.BytesIO(raw), dtype="float32")
        # The 12Hz tokenizer produces 1920 samples per frame at 24 kHz.
        if self.truncated or len(samples) / sr >= (limit - 1) * .08 - .005:
            raise RuntimeError("声音达到生成长度上限，未作为完整回复播放，请缩短朗读内容。")
        if self.reference_fallback:
            raise RuntimeError("GGUF 缺少完整音色编码器，请重新运行语音准备。")
        synthesis_ms = round((time.monotonic() - started) * 1000)
        post = time.monotonic()
        audio, metrics = render_audio(samples, sr, text, speed, self.profile)
        metrics.update(synthesisMs=synthesis_ms, postprocessMs=round((time.monotonic() - post) * 1000),
                       rawAudioMs=round(len(samples) / sr * 1000), backend="gguf", engine="llama.cpp " + BUILD,
                       device=self.device, gpuLayers="/".join(map(str, self.gpu_layers)), referenceMode="icl")
        return audio, metrics
