"""Cross-assemble pinned Windows x64 offline GGUF archives without running Windows.

Prepare dependencies first; after committing, package only that Git commit:
  python scripts/package_windows.py --prepare-only
  python scripts/package_windows.py --source-ref HEAD --output-dir releases/voice-gguf

Two ZIPs share the PomegranagentV2/ root. Extract both to the same folder.
BF16 is optional and installed separately. This does not certify Windows execution.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from setup_voice import digest, download_verified, extract_archive, install_llama, install_msvc, manifest, verify_file

EXCLUDE_PARTS = {".git", "__pycache__", ".acceptance", "node_modules", ".venv", ".venv-tts", ".DS_Store"}
SOURCE_ROOTS = {"server.py", "backend", "web", "assets", "scripts", "README.md", "docs"}


def prepare_python(destination, cache, config):
    source = config["windowsPython"]
    runtime = destination / ".runtime/python"
    marker = runtime / "distribution.json"
    if marker.is_file() and json.loads(marker.read_text()) == source and (runtime / "python.exe").is_file():
        return
    archive = download_verified(source["url"], cache / source["path"], source)
    with tempfile.TemporaryDirectory(prefix=".python-", dir=destination) as staging:
        extract_archive(archive, staging)
        extracted = Path(staging) / "python"
        if not (extracted / "python.exe").is_file():
            raise RuntimeError("Windows Python archive root changed")
        runtime.parent.mkdir(parents=True, exist_ok=True)
        if runtime.exists():
            shutil.rmtree(runtime)
        extracted.replace(runtime)
    marker.write_text(json.dumps(source, indent=2) + "\n")


def prepare_wheels(destination, cache, config):
    target = destination / ".runtime/app-packages"
    marker = target / "distribution.json"
    if marker.is_file() and json.loads(marker.read_text()) == config["windowsWheels"]:
        return
    with tempfile.TemporaryDirectory(prefix=".wheels-", dir=destination) as staging:
        staged = Path(staging) / "packages"
        staged.mkdir()
        for item in config["windowsWheels"]:
            archive = download_verified(item["url"], cache / item["path"], item)
            wheel_root = Path(staging) / item["path"]
            extract_archive(archive, wheel_root)
            # Wheel purelib/platlib are relocated into the import directory.
            # Only distribution scripts/data outside import roots are omitted.
            for path in wheel_root.iterdir():
                if path.name.endswith(".data"):
                    for component in ("purelib", "platlib"):
                        directory = path / component
                        if directory.is_dir():
                            shutil.copytree(directory, staged, dirs_exist_ok=True)
                elif path.is_dir():
                    shutil.copytree(path, staged / path.name, dirs_exist_ok=True)
                else:
                    shutil.copy2(path, staged / path.name)
        (staged / "distribution.json").write_text(json.dumps(config["windowsWheels"], indent=2) + "\n")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        staged.replace(target)


def prepare(destination, cache):
    destination.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    config = manifest()
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = [pool.submit(prepare_python, destination, cache, config),
                pool.submit(prepare_wheels, destination, cache, config),
                pool.submit(install_llama, "windows-x64", destination / "models", cache)]
        for job in jobs:
            job.result()
    vc = config["windowsVCRedist"]
    vc_archive = download_verified(vc["url"], cache / vc["path"], vc)
    shutil.copy2(vc_archive, destination / ".runtime" / vc["path"])
    native = destination / "models" / config["llama"]["directory"]
    # The portable Python distribution ships Microsoft's redistributable runtime.
    # Copy beside the child executable so DLL lookup doesn't depend on global PATH.
    copied = []
    for path in (destination / ".runtime/python").glob("vcruntime*.dll"):
        target = native / path.name
        if not target.exists():
            shutil.copy2(path, target)
            copied.append(path.name)
    seven_zip = None
    if sys.platform == "darwin":
        tool = config["macPackagingTool"]
        tool_archive = download_verified(tool["url"], cache / tool["path"], tool)
        tool_dir = cache / "7zip-mac"
        extract_archive(tool_archive, tool_dir)
        seven_zip = tool_dir / "7zz"
    install_msvc(native, cache, seven_zip=seven_zip)
    report = {"target": "Windows x64", "python": config["windowsPython"], "wheels": config["windowsWheels"],
              "nativeRelease": config["llama"]["release"], "copiedCRuntimeDlls": copied,
              "vcRedist": config["windowsVCRedist"],
              "validation": "Cross-assembled on host; Windows/NVIDIA execution is pending."}
    (destination / "prepared.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Windows runtime prepared: " + str(destination), flush=True)


def allowed_source(path):
    parts = path.parts
    if any(p in EXCLUDE_PARTS for p in parts) or path.suffix in (".pyc", ".log", ".sqlite3", ".db"):
        return False
    # Include production code and its docs, not evaluation artifacts or secrets.
    return parts[0] in SOURCE_ROOTS or (len(parts) == 1 and (path.suffix in (".bat", ".command") or path.name.startswith("requirements-")))


def append_tree(archive, source, relative, entries):
    for file in sorted(source.rglob("*")):
        if not file.is_file() or any(part in EXCLUDE_PARTS for part in file.relative_to(source).parts) or file.suffix == ".pyc":
            continue
        path = relative / file.relative_to(source)
        archive.write(file, "PomegranagentV2/" + path.as_posix())
        entries.append({"path": path.as_posix(), "bytes": file.stat().st_size, "sha256": digest(file)})


def build(source_ref, prepared, model_root, output):
    config = manifest()
    required = [prepared / ".runtime/python/python.exe", prepared / ".runtime/app-packages/distribution.json",
                prepared / "models" / config["llama"]["directory"] / "llama-server.exe"]
    if not all(path.is_file() for path in required):
        raise RuntimeError("先使用 --prepare-only 准备 Windows 运行时。")
    commit = subprocess.check_output(["git", "rev-parse", source_ref + "^{commit}"], cwd=ROOT, text=True).strip()
    archive_bytes = subprocess.check_output(["git", "archive", "--format=tar", commit], cwd=ROOT)
    model_dirs = [model_root / config["gguf"]["directory"], model_root / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"]
    for item in config["gguf"]["files"]:
        if not verify_file(model_dirs[0] / item["path"], item):
            raise RuntimeError("GGUF model is missing or has wrong SHA256: " + item["path"])
    for name in ("model.int8.onnx", "tokens.txt", "LICENSE"):
        if not (model_dirs[1] / name).is_file():
            raise RuntimeError("SenseVoice model is incomplete")
    output.mkdir(parents=True, exist_ok=True)
    runtime_zip = output / "PomegranagentV2-windows-x64-runtime.zip"
    models_zip = output / "PomegranagentV2-windows-x64-gguf-models.zip"
    if runtime_zip.exists() or models_zip.exists():
        raise RuntimeError("目标发行包已存在，请用新的输出目录保留旧包。")
    sources = []
    with tempfile.TemporaryDirectory(prefix="pome-committed-source-") as directory:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as tree:
            tree.extractall(directory, filter="data")
        snapshot = Path(directory)
        # Pin preparation and packaging to the exact committed manifest.
        if json.loads((snapshot / "assets/voice/qwen-models.json").read_text()) != config:
            raise RuntimeError("Working manifest differs from source commit; commit manifest before packaging.")
        with zipfile.ZipFile(runtime_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as zipped:
            for path in sorted(snapshot.rglob("*")):
                relative = path.relative_to(snapshot)
                if path.is_file() and allowed_source(relative):
                    zipped.write(path, "PomegranagentV2/" + relative.as_posix())
                    sources.append({"path": relative.as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)})
            append_tree(zipped, prepared / ".runtime", Path(".runtime"), sources)
            append_tree(zipped, prepared / "models", Path("models"), sources)
            zipped.writestr("PomegranagentV2/WINDOWS-PACKAGE.txt",
                "Extract BOTH runtime.zip and models.zip into the same folder.\r\n"
                "Open PomegranagentV2\\launch.bat for GGUF CUDA.\r\n"
                "If Windows reports a missing MSVCP140 DLL, run .runtime\\VC_redist.x64.exe once.\r\n"
                "BF16 is optional: launch-bf16.bat installs it when needed.\r\n"
                "Local speech needs no internet after extraction; dialogue credentials are configured separately.\r\n"
                "Windows RTX 4060 execution awaits device validation.\r\n"
                "Source commit: " + commit + "\r\n")
    model_entries = []
    with zipfile.ZipFile(models_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as zipped:
        for directory in model_dirs:
            append_tree(zipped, directory, Path("models") / directory.name, model_entries)
    artifacts = [{"file": p.name, "bytes": p.stat().st_size, "sha256": digest(p)} for p in (runtime_zip, models_zip)]
    if any(item["bytes"] >= 2 * 1024**3 for item in artifacts):
        raise RuntimeError("单个 ZIP 超过 GitHub Release 2 GiB；文件已保留，需调整分包。")
    report = {"sourceCommit": commit, "target": "Windows x64 + NVIDIA CUDA 12.4", "artifacts": artifacts,
              "runtimeFiles": sources, "modelFiles": model_entries,
              "validation": "Windows files and checksums inspected; Windows/NVIDIA execution is pending."}
    (output / "windows-package-manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text("".join(f"{p['sha256']}  {p['file']}\n" for p in artifacts), encoding="utf-8")
    print(json.dumps({"sourceCommit": commit, "artifacts": artifacts}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--prepared", type=Path, default=ROOT / ".acceptance/windows-gguf-package/prepared")
    parser.add_argument("--cache", type=Path, default=ROOT / ".acceptance/windows-gguf-package/downloads")
    parser.add_argument("--model-root", type=Path, default=ROOT / "models")
    parser.add_argument("--source-ref", default="HEAD")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "releases/voice-gguf-20261119")
    args = parser.parse_args()
    if args.prepare_only:
        prepare(args.prepared.resolve(), args.cache.resolve())
    else:
        build(args.source_ref, args.prepared.resolve(), args.model_root.resolve(), args.output_dir.resolve())


if __name__ == "__main__":
    main()
