"""Install pinned local voice models; run with the project's Python 3.12 venv.

python scripts/setup_voice.py installs dependencies into that interpreter and
downloads models. --models-only skips dependency installation. No global edits.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
MODELS = (
    ("asr-models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
     "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"),
)
REQUIRED_FILES = {
    MODELS[0][1]: ("model.int8.onnx", "tokens.txt", "LICENSE"),
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


def qwen_kind():
    if sys.platform == 'darwin' and platform.machine() == 'arm64':
        return 'mlx'
    if os.name == 'nt' and platform.machine().lower() in ('amd64', 'x86_64'):
        return 'cuda'
    raise SystemExit('本版 Qwen 支持 Apple Silicon Mac 或 Windows x64 + NVIDIA CUDA；未提供 CPU 回退。')


def verify_file(path, item):
    if not path.is_file() or path.stat().st_size != item['size']:
        return False
    if 'sha256' in item:
        return digest(path) == item['sha256']
    data = path.read_bytes()
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == item['gitBlobSha1']


def install_qwen(kind):
    source = json.loads((ROOT / 'assets/voice/qwen-models.json').read_text(encoding='utf-8'))[kind]
    target = ROOT / 'models' / source['directory']
    target.mkdir(parents=True, exist_ok=True)
    for item in source['files']:
        path = target / item['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        if verify_file(path, item):
            continue
        url = f"https://huggingface.co/{source['repository']}/resolve/{source['revision']}/{item['path']}"
        part = path.with_name(path.name + '.part')
        for attempt in range(3):
            offset = part.stat().st_size if part.exists() else 0
            if offset >= item['size']:
                if verify_file(part, item):
                    break
                part.unlink()
                offset = 0
            headers = {'User-Agent': 'Pomegranagent-V2-local-voice'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            print(f"Qwen {item['path']}: {offset / 1e6:.0f}/{item['size'] / 1e6:.0f} MB", flush=True)
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as response:
                    resume = offset > 0 and response.status == 206 and response.headers.get('Content-Range', '').startswith(f'bytes {offset}-')
                    with part.open('ab' if resume else 'wb') as out:
                        shutil.copyfileobj(response, out, length=1024 * 1024)
                if verify_file(part, item):
                    break
            except OSError:
                if attempt == 2:
                    raise
        if not verify_file(part, item):
            raise RuntimeError(f"Qwen model checksum mismatch: {item['path']}")
        part.replace(path)
    (target / 'source.json').write_text(json.dumps(source, indent=2) + '\n', encoding='utf-8')
    print('Ready: Qwen3-TTS Base / 好奇女孩', flush=True)


def pip_install(python, arguments):
    uv = shutil.which('uv')
    command = [uv, 'pip', 'install', '--python', str(python)] if uv else [str(python), '-m', 'pip', 'install']
    subprocess.run(command + arguments, check=True)


def check_ready():
    sys.path.insert(0, str(ROOT))
    from backend.local_voice import LocalVoice
    status = LocalVoice(ROOT / 'models').status()
    if not status['ready']:
        return False
    from backend.qwen_voice import worker_python
    code = 'import mlx.core, mlx_audio, soundfile, pyloudnorm, imageio_ffmpeg' if qwen_kind() == 'mlx' else 'import qwen_tts, torch, soundfile, pyloudnorm, imageio_ffmpeg; assert torch.cuda.is_available()'
    env = dict(os.environ, PYTHONNOUSERSITE='1')
    env.pop('PYTHONPATH', None)
    if (ROOT / '.runtime/tts-packages').is_dir():
        env['PYTHONPATH'] = str(ROOT / '.runtime/tts-packages')
    return subprocess.run([str(worker_python()), '-c', code], env=env, stdout=subprocess.DEVNULL).returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-only", action="store_true")
    parser.add_argument("--check", action="store_true", help="检查本机安装，不联网、不修改文件")
    args = parser.parse_args()
    if args.check:
        raise SystemExit(0 if check_ready() else 1)
    if sys.version_info < (3, 12):
        raise SystemExit('请使用 Python 3.12 创建项目 .venv，再运行语音准备脚本。')
    kind = qwen_kind()
    if not args.models_only:
        if sys.prefix == sys.base_prefix:
            raise SystemExit("请先创建项目 .venv，再使用 .venv 中的 Python 运行；不会安装到全局。")
        pip_install(sys.executable, ['--only-binary=:all:', '-r', str(ROOT / 'requirements-voice.txt')])
        tts_venv = ROOT / '.venv-tts'
        python = tts_venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        if not python.is_file():
            venv.EnvBuilder(with_pip=True).create(tts_venv)
        if kind == 'cuda':
            pip_install(python, ['torch==2.10.0', 'torchaudio==2.10.0', '--index-url', 'https://download.pytorch.org/whl/cu128'])
        requirements = 'requirements-tts-mac.lock' if kind == 'mlx' else 'requirements-tts-windows.txt'
        pip_install(python, ['-r', str(ROOT / requirements)])
    install_models()
    install_qwen(kind)
    if not args.models_only and not check_ready():
        raise SystemExit('语音依赖未通过检查；Windows 请确认 NVIDIA 驱动支持 CUDA 12.8。')


if __name__ == "__main__":
    main()
