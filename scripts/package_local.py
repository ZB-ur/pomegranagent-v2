"""Build an offline, relocatable bundle for the current OS after setup-voice.

Includes the Python runtime, both dependency environments, selected Qwen weights,
SenseVoice, fixed reference and guidance. Excludes classroom data, keys, acceptance
artifacts and the old Kokoro model. Run on each target OS; Mac != Windows proof.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.local_voice import LocalVoice
from backend.qwen_voice import model_directory, worker_python


def environment(python):
    code = 'import sys,sysconfig,json;print(json.dumps({"base":sys.base_prefix,"packages":sysconfig.get_path("purelib")}))'
    return json.loads(subprocess.check_output([str(python), '-c', code], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not LocalVoice(ROOT / 'models').status()['ready']:
        raise SystemExit('先完成 setup-voice，再打包。')
    app, tts = environment(sys.executable), environment(worker_python())
    runtime = Path(app['base'])
    if sys.platform == 'darwin' and not (runtime / 'bin/python3.12').is_file():
        raise SystemExit('Mac 打包请使用 uv 的可迁移 Python 3.12 runtime。')
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit('目标文件已存在；请使用新的输出路径以保留旧包。')
    name = 'PomegranagentV2'
    entries = [(ROOT / item, item) for item in (
        'server.py', 'backend', 'web', 'assets', 'scripts', 'README.md', 'docs/product.md', 'docs/user-guide.md',
        'launch.command', 'launch.bat', 'setup-voice.command', 'setup-voice.bat',
        'requirements-voice.txt', 'requirements-tts-mac.txt', 'requirements-tts-mac.lock', 'requirements-tts-windows.txt')]
    entries.extend([(runtime, '.runtime/python'), (Path(app['packages']), '.runtime/app-packages'),
                    (Path(tts['packages']), '.runtime/tts-packages'),
                    (ROOT / 'models' / LocalVoice.ASR_DIR, 'models/' + LocalVoice.ASR_DIR),
                    (model_directory(ROOT / 'models'), 'models/' + model_directory(ROOT / 'models').name)])
    def keep(info):
        parts = Path(info.name).parts
        if '__pycache__' in parts or info.name.endswith(('.pyc', '.log', '.sqlite3', '.db')):
            return None
        # Portable base Python may contain installer/cache tooling; no home state.
        if '.cache' in parts or '.DS_Store' in parts:
            return None
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        return info
    with tarfile.open(output, 'w:gz', compresslevel=1, dereference=True) as archive:
        for source, relative in entries:
            print('Packaging ' + relative, flush=True)
            archive.add(source, arcname=name + '/' + relative, filter=keep)
    with output.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    report = {'archive': str(output), 'sha256': digest, 'bytes': output.stat().st_size,
              'platform': platform.system(), 'architecture': platform.machine(), 'python': platform.python_version(),
              'contents': [relative for _, relative in entries],
              'scope': 'Offline local ASR/TTS runtime; dialogue service credentials are configured separately.'}
    output.with_suffix(output.suffix + '.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
