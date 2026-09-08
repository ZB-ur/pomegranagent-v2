"""Install pinned local voice models; run with the project's Python 3.12 venv.

python scripts/setup_voice.py installs dependencies into that interpreter and
downloads models. --models-only skips dependency installation. No global edits.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODELS = (
    ("asr-models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
     "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"),
    ("tts-models", "kokoro-multi-lang-v1_1",
     "a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad"),
)
REQUIRED_FILES = {
    MODELS[0][1]: ("model.int8.onnx", "tokens.txt", "LICENSE"),
    MODELS[1][1]: ("model.onnx", "tokens.txt", "voices.bin", "lexicon-zh.txt", "lexicon-us-en.txt",
                   "espeak-ng-data/phontab", "espeak-ng-data/phondata", "espeak-ng-data/phonindex",
                   "date-zh.fst", "number-zh.fst", "phone-zh.fst", "LICENSE"),
}


def model_complete(target: Path, name: str) -> bool:
    return all((target / item).is_file() and (target / item).stat().st_size > 0
               for item in REQUIRED_FILES[name])


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def install_models():
    dest = ROOT / "models"
    dest.mkdir(exist_ok=True)
    sources = []
    for release, name, sha in MODELS:
        url = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/{release}/{name}.tar.bz2"
        archive = dest / (name + ".tar.bz2")
        target = dest / name
        marker = target / ".installed-sha256"
        if not (marker.is_file() and marker.read_text().strip() == sha and model_complete(target, name)):
            if not archive.is_file() or digest(archive) != sha:
                part = archive.with_suffix(".part")
                print(f"Downloading {name}", flush=True)
                req = urllib.request.Request(url, headers={"User-Agent": "Pomegranagent-V2-voice-setup"})
                with urllib.request.urlopen(req, timeout=120) as response, part.open("wb") as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
                if digest(part) != sha:
                    part.unlink(missing_ok=True)
                    raise RuntimeError(f"SHA256 mismatch: {name}")
                part.replace(archive)
            print(f"Verified SHA256; extracting {name}", flush=True)
            with tempfile.TemporaryDirectory(prefix=".extract-", dir=dest) as staging:
                with tarfile.open(archive, "r:bz2") as tar:
                    # Reject links and special files; data filter also blocks traversal.
                    if any(not (m.isfile() or m.isdir()) for m in tar.getmembers()):
                        raise RuntimeError("Model archive contains unsupported special files")
                    tar.extractall(staging, filter="data")
                extracted = Path(staging) / name
                if not extracted.is_dir():
                    raise RuntimeError("Unexpected model archive root")
                if not model_complete(extracted, name):
                    raise RuntimeError("Model archive is missing required files")
                if target.exists():
                    shutil.rmtree(target)
                extracted.replace(target)
            marker.write_text(sha + "\n")
            archive.unlink()
        sources.append({"name": name, "url": url, "sha256": sha,
                        "hashSource": "GitHub release asset digest", "path": name})
        print(f"Ready: {name}", flush=True)
    (dest / "sources.json").write_text(json.dumps(sources, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-only", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        raise SystemExit('请使用 Python 3.12 创建项目 .venv，再运行语音准备脚本。')
    if not args.models_only:
        if sys.prefix == sys.base_prefix:
            raise SystemExit("请先创建项目 .venv，再使用 .venv 中的 Python 运行；不会安装到全局。")
        if importlib.util.find_spec("pip"):
            command = [sys.executable, "-m", "pip", "install", "--only-binary=:all:"]
        elif shutil.which("uv"):
            command = [shutil.which("uv"), "pip", "install", "--python", sys.executable, "--only-binary=:all:"]
        else:
            raise SystemExit("项目虚拟环境缺少 pip；请使用 python -m venv .venv 创建环境。")
        subprocess.run(command + ["-r", str(ROOT / "requirements-voice.txt")], check=True)
    install_models()


if __name__ == "__main__":
    main()
