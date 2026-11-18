"""Build a relocatable offline bundle for this OS from committed source.

Run setup-voice first. GGUF includes its native executable and libraries;
MLX/BF16 include the isolated TTS environment. No classroom data or keys.
For cross-assembled Windows GGUF ZIPs, use package_windows.py instead.
"""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import platform
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.local_voice import LocalVoice
from backend.qwen_voice import backend_name, model_directory, worker_python


def environment(python):
    code = 'import sys,sysconfig,json;print(json.dumps({"base":sys.base_prefix,"packages":sysconfig.get_path("purelib")}))'
    return json.loads(subprocess.check_output([str(python), '-c', code], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--backend', choices=('auto', 'mlx', 'gguf', 'bf16'), default=None)
    parser.add_argument('--source-ref', default='HEAD', help='只打包此 Git 提交的源码，不含工作区未提交修改')
    args = parser.parse_args()
    if args.backend:
        os.environ['DUCK_TTS_BACKEND'] = args.backend
    kind = backend_name()
    if not LocalVoice(ROOT / 'models').status()['ready']:
        raise SystemExit('先完成所选后端的 setup-voice，再打包。')
    app = environment(sys.executable)
    runtime = Path(app['base'])
    if sys.platform == 'darwin' and not (runtime / 'bin/python3.12').is_file():
        raise SystemExit('Mac 打包请使用 uv 的可迁移 Python 3.12 runtime。')
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit('目标文件已存在；请使用新的输出路径以保留旧包。')
    commit = subprocess.check_output(['git', 'rev-parse', args.source_ref + '^{commit}'], cwd=ROOT, text=True).strip()
    source_tar = subprocess.check_output(['git', 'archive', '--format=tar', commit], cwd=ROOT)
    def keep(info):
        parts = Path(info.name).parts
        if '__pycache__' in parts or info.name.endswith(('.pyc', '.log', '.sqlite3', '.db')) or '.cache' in parts or '.DS_Store' in parts:
            return None
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        return info
    with tempfile.TemporaryDirectory(prefix='pome-package-source-') as folder:
        source = Path(folder)
        with tarfile.open(fileobj=io.BytesIO(source_tar)) as source_archive:
            source_archive.extractall(source, filter='data')
        if (source / 'assets/voice/qwen-models.json').read_bytes() != (ROOT / 'assets/voice/qwen-models.json').read_bytes():
            raise SystemExit('模型清单尚未提交，请提交后再打包。')
        entries = [(source / item, item) for item in ('server.py', 'backend', 'web', 'assets', 'scripts', 'README.md', 'docs/product.md', 'docs/user-guide.md')]
        entries.extend((p, p.name) for p in source.iterdir() if p.is_file() and (p.suffix in ('.bat', '.command') or p.name.startswith('requirements-')))
        app_packages = ROOT / '.runtime/app-packages'
        entries.extend([(runtime, '.runtime/python'),
                        (app_packages if app_packages.is_dir() else Path(app['packages']), '.runtime/app-packages'),
                        (ROOT / 'models' / LocalVoice.ASR_DIR, 'models/' + LocalVoice.ASR_DIR),
                        (model_directory(ROOT / 'models'), 'models/' + model_directory(ROOT / 'models').name)])
        if kind == 'gguf':
            config = json.loads((ROOT / 'assets/voice/qwen-models.json').read_text())['llama']
            entries.append((ROOT / 'models' / config['directory'], 'models/' + config['directory']))
        else:
            tts = environment(worker_python(kind))
            tts_packages = ROOT / '.runtime/tts-packages'
            entries.append((tts_packages if tts_packages.is_dir() else Path(tts['packages']), '.runtime/tts-packages'))
        with tarfile.open(output, 'w:gz', compresslevel=1, dereference=True) as archive:
            for path, relative in entries:
                print('Packaging ' + relative, flush=True)
                archive.add(path, arcname='PomegranagentV2/' + relative, filter=keep)
    with output.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    report = {'archive': str(output), 'sha256': digest, 'bytes': output.stat().st_size,
              'sourceCommit': commit, 'backend': kind,
              'platform': platform.system(), 'architecture': platform.machine(), 'python': platform.python_version(),
              'contents': [relative for _, relative in entries],
              'scope': 'Offline local ASR/TTS runtime; dialogue credentials configured separately. Other platforms are not validated.'}
    output.with_suffix(output.suffix + '.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
