"""Prepare local speech: MLX on Apple Silicon, GGUF CUDA on Windows, optional BF16.

All downloads are pinned and checked. --check is read-only and never downloads.
Dependencies stay in the project's virtual environments or portable runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import venv
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MODELS = (("asr-models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
           "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"),)
REQUIRED_FILES = {MODELS[0][1]: ("model.int8.onnx", "tokens.txt", "LICENSE")}


def manifest():
    return json.loads((ROOT / "assets/voice/qwen-models.json").read_text(encoding="utf-8"))


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def verify_file(path, item):
    path = Path(path)
    if not path.is_file() or ("size" in item and path.stat().st_size != item["size"]):
        return False
    if "sha256" in item:
        return digest(path) == item["sha256"]
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == item["gitBlobSha1"]


def download_verified(url, path, item):
    """Resume only when the server confirms the requested byte range."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if verify_file(path, item):
        return path
    part = path.with_name(path.name + ".part")
    for attempt in range(3):
        offset = part.stat().st_size if part.is_file() else 0
        if offset and item.get("size") and offset >= item["size"]:
            if verify_file(part, item):
                part.replace(path)
                return path
            part.unlink()
            offset = 0
        headers = {"User-Agent": "Pomegranagent-V2-local-voice"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        print(f"Downloading {path.name}: {offset / 1e6:.0f} MB received", flush=True)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as response:
                resume = offset > 0 and response.status == 206 and response.headers.get("Content-Range", "").startswith(f"bytes {offset}-")
                with part.open("ab" if resume else "wb") as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
            if verify_file(part, item):
                part.replace(path)
                return path
            part.unlink(missing_ok=True)
        except OSError:
            if attempt == 2:
                raise
    raise RuntimeError(f"下载文件校验失败：{path.name}，请重试。")


def extract_archive(archive, destination):
    """Extract verified vendor archives, rejecting traversal and special files."""
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zipped:
            for item in zipped.infolist():
                name = PurePosixPath(item.filename.replace("\\", "/"))
                if name.is_absolute() or ".." in name.parts or any(":" in p for p in name.parts):
                    raise RuntimeError("Unsafe archive path")
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise RuntimeError("Archive contains unsupported special files")
            zipped.extractall(destination)
    else:
        with tarfile.open(archive) as tar:
            # data also verifies that permitted vendor dylib links stay inside destination.
            if any(not (m.isfile() or m.isdir() or m.issym() or m.islnk()) for m in tar.getmembers()):
                raise RuntimeError("Archive contains unsupported special files")
            tar.extractall(destination, filter="data")


def model_complete(target, name):
    return all((target / item).is_file() and (target / item).stat().st_size > 0
               for item in REQUIRED_FILES[name])


def install_models(model_root=None):
    dest = Path(model_root) if model_root else ROOT / "models"
    dest.mkdir(parents=True, exist_ok=True)
    sources = []
    for release, name, sha in MODELS:
        url = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/{release}/{name}.tar.bz2"
        target, archive = dest / name, dest / (name + ".tar.bz2")
        marker = target / ".installed-sha256"
        if not (marker.is_file() and marker.read_text().strip() == sha and model_complete(target, name)):
            download_verified(url, archive, {"sha256": sha})
            with tempfile.TemporaryDirectory(prefix=".extract-", dir=dest) as staging:
                extract_archive(archive, staging)
                extracted = Path(staging) / name
                if not model_complete(extracted, name):
                    raise RuntimeError("Model archive is missing required files")
                if target.exists():
                    shutil.rmtree(target)
                extracted.replace(target)
            marker.write_text(sha + "\n")
            archive.unlink()
        sources.append({"name": name, "url": url, "sha256": sha, "path": name})
        print(f"Ready: {name}", flush=True)
    (dest / "sources.json").write_text(json.dumps(sources, indent=2) + "\n", encoding="utf-8")


def platform_key():
    if sys.platform == "darwin" and platform.machine() == "arm64":
        return "mac-arm64"
    if os.name == "nt" and platform.machine().lower() in ("amd64", "x86_64"):
        return "windows-x64"
    raise RuntimeError("语音支持 Apple Silicon Mac 或 Windows x64 + NVIDIA 显卡；没有 CPU 回退。")


def qwen_kind(requested=None):
    kind = (requested or os.environ.get("DUCK_TTS_BACKEND", "auto")).lower()
    kind = "bf16" if kind == "cuda" else kind
    target = platform_key()
    if kind == "auto":
        return "mlx" if target == "mac-arm64" else "gguf"
    if kind not in ("mlx", "gguf", "bf16"):
        raise RuntimeError("DUCK_TTS_BACKEND 应为 auto、mlx、gguf 或 bf16。")
    if kind == "mlx" and target != "mac-arm64":
        raise RuntimeError("MLX 只支持 Apple Silicon Mac。")
    if kind == "bf16" and target != "windows-x64":
        raise RuntimeError("本项目 BF16 对照需要 Windows + NVIDIA CUDA。")
    return kind


def install_qwen(kind, model_root=None):
    source = manifest()["cuda" if kind == "bf16" else kind]
    target = (Path(model_root) if model_root else ROOT / "models") / source["directory"]
    for item in source["files"]:
        url = item.get("url") or f"https://huggingface.co/{source['repository']}/resolve/{source['revision']}/{item['path']}"
        download_verified(url, target / item["path"], item)
    (target / "source.json").write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    print(f"Ready: Qwen3-TTS Base / 好奇女孩 / {kind}", flush=True)
    return target


def install_llama(target_platform=None, model_root=None, cache_dir=None):
    config = manifest()["llama"]
    target_platform = target_platform or platform_key()
    source = config["platforms"][target_platform]
    target = (Path(model_root) if model_root else ROOT / "models") / config["directory"]
    cache = Path(cache_dir) if cache_dir else ROOT / "models/.downloads"
    marker = target / "installed.json"
    if marker.is_file():
        installed = json.loads(marker.read_text(encoding="utf-8"))
        if installed.get("platform") == target_platform and installed.get("archives") == source["archives"] and source["executable"] in installed.get("files", {}) and all(
                verify_file(target / p, info) for p, info in installed.get("files", {}).items()) and (target / source["executable"]).is_file():
            return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".llama-", dir=target.parent) as temporary:
        staged = Path(temporary) / "flat"
        staged.mkdir()
        for index, item in enumerate(source["archives"]):
            archive = download_verified(item["url"], cache / item["path"], item)
            extracted = Path(temporary) / str(index)
            extract_archive(archive, extracted)
            for path in extracted.rglob("*"):
                if not path.is_file():
                    continue
                if not path.resolve().is_relative_to(extracted.resolve()):
                    raise RuntimeError("Native runtime link escapes archive")
                if path.name == source["executable"] or path.suffix.lower() in (".dll", ".dylib") or path.name.lower().startswith(("license", "copying")):
                    dest = staged / path.name
                    if dest.exists() and digest(dest) != digest(path):
                        raise RuntimeError(f"Conflicting native runtime file: {path.name}")
                    shutil.copy2(path, dest)
        executable = staged / source["executable"]
        if not executable.is_file():
            raise RuntimeError("Native speech archive is missing llama-server")
        executable.chmod(executable.stat().st_mode | 0o111)
        if target_platform == "windows-x64" and os.name == "nt":
            for path in Path(sys.base_prefix).glob("vcruntime*.dll"):
                if not (staged / path.name).exists():
                    shutil.copy2(path, staged / path.name)
        files = {p.name: {"size": p.stat().st_size, "sha256": digest(p)} for p in staged.iterdir() if p.is_file()}
        (staged / "installed.json").write_text(json.dumps({"platform": target_platform, "release": config["release"], "archives": source["archives"], "files": files}, indent=2) + "\n", encoding="utf-8")
        if target.exists():
            shutil.rmtree(target)
        staged.replace(target)
    return target


def pip_install(python, arguments):
    uv = shutil.which("uv")
    command = [uv, "pip", "install", "--python", str(python)] if uv else [str(python), "-m", "pip", "install"]
    subprocess.run(command + arguments, check=True)


def install_msvc(target, cache, seven_zip=None):
    """Use Microsoft's pinned redistributable as app-local DLLs; no system install."""
    config = manifest()["windowsVCRedist"]
    target, cache = Path(target), Path(cache)
    if all(verify_file(target / item["path"], item) for item in config["files"]):
        return
    archive = download_verified(config["url"], cache / config["path"], config)
    with tempfile.TemporaryDirectory(prefix=".msvc-", dir=cache) as temporary:
        temporary = Path(temporary)
        payload = temporary / "payload.cab"
        with archive.open("rb") as file:
            file.seek(config["payloadCabOffset"])
            payload.write_bytes(file.read(config["payloadCabSize"]))
        if payload.read_bytes()[:4] != b"MSCF":
            raise RuntimeError("Microsoft runtime cabinet layout changed")
        def expand(cab, folder, names):
            folder.mkdir()
            if os.name == "nt" and seven_zip is None:
                command = [str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/expand.exe"), "-F:" + names, str(cab), str(folder)]
            elif seven_zip:
                command = [str(seven_zip), "x", str(cab), "-o" + str(folder), "-y", names]
            else:
                raise RuntimeError("Cross-assembly requires the pinned 7-Zip tool.")
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        container = temporary / "container"
        expand(payload, container, config["runtimeCab"])
        runtime = container / config["runtimeCab"]
        if digest(runtime) != config["runtimeCabSha256"]:
            raise RuntimeError("Microsoft runtime cabinet checksum mismatch")
        extracted = temporary / "dlls"
        expand(runtime, extracted, "*")
        for item in config["files"]:
            file = extracted / item["archivePath"]
            if not verify_file(file, item):
                raise RuntimeError("Microsoft runtime DLL checksum mismatch: " + item["path"])
            shutil.copy2(file, target / item["path"])
    marker = target / "installed.json"
    if marker.is_file():
        installed = json.loads(marker.read_text(encoding="utf-8"))
        for item in config["files"]:
            installed["files"][item["path"]] = {k: item[k] for k in ("size", "sha256")}
        installed["microsoftRuntime"] = config["sha256"]
        marker.write_text(json.dumps(installed, indent=2) + "\n", encoding="utf-8")


def check_ready(kind=None):
    kind = kind or qwen_kind()
    os.environ["DUCK_TTS_BACKEND"] = kind
    sys.path.insert(0, str(ROOT))
    from backend.local_voice import LocalVoice
    if not LocalVoice(ROOT / "models").status()["ready"]:
        return False
    env = dict(os.environ, PYTHONNOUSERSITE="1")
    env.pop("PYTHONPATH", None)
    if kind == "gguf":
        if (ROOT / ".runtime/app-packages").is_dir():
            env["PYTHONPATH"] = str(ROOT / ".runtime/app-packages")
        command = [sys.executable, "-c", "import soundfile,pyloudnorm,imageio_ffmpeg,numpy"]
        if subprocess.run(command, env=env).returncode:
            return False
        source = manifest()["llama"]
        executable = ROOT / "models" / source["directory"] / source["platforms"][platform_key()]["executable"]
        try:
            result = subprocess.run([str(executable), "--list-devices"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        except (OSError, subprocess.TimeoutExpired):
            print("无法启动本地语音程序。Windows 缺少 MSVCP140 等库时，请运行 .runtime/VC_redist.x64.exe 或微软官方 VC++ x64 运行库安装器。", file=sys.stderr)
            return False
        output = result.stdout + result.stderr
        if result.returncode or not re.search(r"\b" + ("CUDA" if os.name == "nt" else "MTL") + r"\d+:", output):
            print("未检测到 GGUF GPU 后端，请检查 NVIDIA 驱动与运行库。", file=sys.stderr)
            return False
        return True
    from backend.qwen_voice import worker_python
    if (ROOT / ".runtime/tts-packages").is_dir():
        env["PYTHONPATH"] = str(ROOT / ".runtime/tts-packages")
    code = "import mlx.core,mlx_audio,soundfile,pyloudnorm,imageio_ffmpeg" if kind == "mlx" else "import qwen_tts,torch,soundfile,pyloudnorm,imageio_ffmpeg; assert torch.cuda.is_available()"
    return subprocess.run([str(worker_python(kind)), "-c", code], env=env, stdout=subprocess.DEVNULL).returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("auto", "mlx", "gguf", "bf16", "cuda"), default=None)
    parser.add_argument("--models-only", action="store_true")
    parser.add_argument("--check", action="store_true", help="检查本机安装，不联网、不修改文件")
    args = parser.parse_args()
    kind = qwen_kind(args.backend)
    os.environ["DUCK_TTS_BACKEND"] = kind
    if args.check:
        raise SystemExit(0 if check_ready(kind) else 1)
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("请使用 Python 3.12 运行语音准备脚本。")
    bundled = Path(sys.executable).resolve().is_relative_to((ROOT / ".runtime/python").resolve())
    if not args.models_only:
        if sys.prefix == sys.base_prefix and not bundled:
            raise SystemExit("请先创建项目 .venv；不会安装到全局 Python。")
        app_target = ["--target", str(ROOT / ".runtime/app-packages"), "--upgrade"] if bundled else []
        pip_install(sys.executable, app_target + ["--only-binary=:all:", "-r", str(ROOT / "requirements-voice.txt")])
        if kind != "gguf":
            python = Path(sys.executable) if bundled else ROOT / ".venv-tts" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            if not python.is_file():
                venv.EnvBuilder(with_pip=True).create(ROOT / ".venv-tts")
            tts_target = ["--target", str(ROOT / ".runtime/tts-packages"), "--upgrade"] if bundled else []
            if kind == "bf16":
                pip_install(python, tts_target + ["torch==2.10.0+cu128", "torchaudio==2.10.0+cu128", "--extra-index-url", "https://download.pytorch.org/whl/cu128", "-r", str(ROOT / "requirements-tts-windows.txt")])
            else:
                pip_install(python, tts_target + ["-r", str(ROOT / "requirements-tts-mac.lock")])
    install_models()
    install_qwen(kind)
    if kind == "gguf":
        native = install_llama()
        if os.name == "nt":
            install_msvc(native, ROOT / "models/.downloads")
    if not args.models_only and not check_ready(kind):
        raise SystemExit("语音准备未通过；请查看上方错误与 NVIDIA 驱动，程序没有切换到 CPU。")


if __name__ == "__main__":
    main()
