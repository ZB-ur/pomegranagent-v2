"""CPU-only local Chinese speech. Audio is never sent to a remote service."""
from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import re
import threading
import wave
from collections import OrderedDict


class LocalVoice:
    ASR_DIR = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
    TTS_DIR = "kokoro-multi-lang-v1_1"
    # Official v1.1 speaker mapping. Keep a small Chinese selection for setup.
    VOICES = {"zf_001": 3, "zf_002": 4, "zf_003": 5, "zf_004": 6, "zm_009": 58}

    def __init__(self, model_root: Path):
        self.model_root = Path(model_root)
        self._asr = None
        self._tts = None
        self._asr_lock = threading.Lock()
        self._tts_lock = threading.Lock()
        self._errors = {}
        self._warming = False
        self._warmup_lock = threading.Lock()
        self._cache = OrderedDict()
        self._cache_bytes = 0

    def status(self) -> dict:
        dependencies = all(importlib.util.find_spec(x) is not None
                           for x in ("sherpa_onnx", "av", "numpy"))
        asr = self.model_root / self.ASR_DIR
        tts = self.model_root / self.TTS_DIR
        asr_ready = dependencies and all((asr / x).is_file() for x in ("model.int8.onnx", "tokens.txt"))
        tts_ready = dependencies and all((tts / x).exists() for x in (
            "model.onnx", "tokens.txt", "voices.bin", "lexicon-zh.txt", "lexicon-us-en.txt", "espeak-ng-data"))
        ready = asr_ready and tts_ready and not self._errors
        message = ("本地中文听说已安装；实际声音和麦克风还需设备试听。" if ready
                   else "本地语音尚未就绪，请运行项目语音安装脚本，并用项目 .venv 启动。")
        if self._errors:
            message = "本地语音加载失败，请重新运行语音安装并查看服务器日志。"
        return {"ready": ready, "asrReady": bool(asr_ready and "asr" not in self._errors),
                "ttsReady": bool(tts_ready and "tts" not in self._errors), "message": message,
                "provider": "local", "asrModel": "SenseVoice Small int8 2024-07-17",
                "ttsModel": "Kokoro v1.1 zh", "defaultVoice": "zf_001",
                "voices": list(self.VOICES), "warming": self._warming,
                "loaded": {"asr": self._asr is not None, "tts": self._tts is not None}}

    def warmup(self) -> dict:
        """Call from a server background thread before children enter."""
        with self._warmup_lock:
            self._warming = True
            try:
                with self._asr_lock:
                    self._load_asr()
                with self._tts_lock:
                    self._load_tts()
            finally:
                self._warming = False
        return self.status()

    def _load_asr(self):
        if self._asr is None:
            root = self.model_root / self.ASR_DIR
            if not all((root / x).is_file() for x in ("model.int8.onnx", "tokens.txt")):
                raise RuntimeError("本地识别模型未安装，请运行项目语音安装脚本。")
            import sherpa_onnx
            try:
                self._asr = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                    model=str(root / "model.int8.onnx"), tokens=str(root / "tokens.txt"),
                    num_threads=2, language="zh", use_itn=True, provider="cpu")
                self._errors.pop("asr", None)
            except Exception:
                self._errors["asr"] = True
                raise
        return self._asr

    def _load_tts(self):
        if self._tts is None:
            root = self.model_root / self.TTS_DIR
            if not all((root / x).exists() for x in ("model.onnx", "voices.bin", "tokens.txt",
                                                    "espeak-ng-data", "lexicon-us-en.txt", "lexicon-zh.txt")):
                raise RuntimeError("本地播音模型未安装，请运行项目语音安装脚本。")
            import sherpa_onnx
            try:
                config = sherpa_onnx.OfflineTtsConfig(
                    model=sherpa_onnx.OfflineTtsModelConfig(
                        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                            model=str(root / "model.onnx"), voices=str(root / "voices.bin"),
                            tokens=str(root / "tokens.txt"), data_dir=str(root / "espeak-ng-data"),
                            lexicon=",".join(str(root / x) for x in ("lexicon-us-en.txt", "lexicon-zh.txt"))),
                        num_threads=2, provider="cpu"),
                    rule_fsts=",".join(str(root / x) for x in ("date-zh.fst", "number-zh.fst", "phone-zh.fst")
                                       if (root / x).is_file()), max_num_sentences=1)
                if not config.validate():
                    raise RuntimeError("本地播音模型文件不完整，请重新安装。")
                self._tts = sherpa_onnx.OfflineTts(config)
                self._errors.pop("tts", None)
            except Exception:
                self._errors["tts"] = True
                raise
        return self._tts

    def transcribe(self, audio: bytes, mime: str) -> str:
        import av
        import numpy as np
        if not audio or len(audio) > 32 * 1024 * 1024:
            raise ValueError("录音为空或超过32MB，请分段讲述。")
        # Probe bytes, rather than trust MIME or pass user paths to FFmpeg.
        chunks = []
        count = 0
        with av.open(io.BytesIO(audio), mode="r") as container:
            if not container.streams.audio:
                raise ValueError("录音中没有声音轨道，请重新录音。")
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    samples = converted.to_ndarray().reshape(-1)
                    count += len(samples)
                    if count > 16000 * 300:
                        raise ValueError("这段录音超过五分钟，请分段讲述。")
                    chunks.append(samples)
            for converted in resampler.resample(None):
                chunks.append(converted.to_ndarray().reshape(-1))
        if not chunks:
            raise ValueError("没有收到录音，请重新试一次。")
        samples = np.concatenate(chunks).astype(np.float32)
        if len(samples) < 1600 or float(np.max(np.abs(samples))) < 0.001:
            return ""
        with self._asr_lock:
            recognizer = self._load_asr()
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, samples)
            recognizer.decode_stream(stream)
            return re.sub(r"<\|[^|]*\|>", "", stream.result.text).strip()

    def speak(self, text: str, voice: str = "") -> bytes:
        import numpy as np
        text = text.strip()
        if not text or len(text) > 1000:
            raise ValueError("播音文字应为1至1000字。")
        selected = voice.strip() or "zf_001"
        if selected not in self.VOICES:
            raise ValueError("请选择已安装的中文音色。")
        with self._tts_lock:
            key = (text, selected)
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            engine = self._load_tts()
            result = engine.generate(text, sid=self.VOICES[selected], speed=0.95)
            samples = np.asarray(result.samples)
            if samples.size == 0:
                raise RuntimeError("本地播音没有生成声音，请重试。")
            pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
            out = io.BytesIO()
            with wave.open(out, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(result.sample_rate)
                wav.writeframes(pcm)
            data = out.getvalue()
            # In-memory only: bounded cache avoids repeated fixed guidance synthesis.
            if len(data) <= 4 * 1024 * 1024:
                self._cache[key] = data
                self._cache_bytes += len(data)
                while len(self._cache) > 48 or self._cache_bytes > 16 * 1024 * 1024:
                    _, removed = self._cache.popitem(last=False)
                    self._cache_bytes -= len(removed)
            return data
