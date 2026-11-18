"""Measure real local speech, sequentially, with frozen fictional audition text.

No dialogue API, classroom database, playback cache, or background app is used.
Close the diary application before running to avoid competition for GPU memory.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.qwen_voice import PROFILE, QwenSpeech


def nvidia_snapshot():
    executable = shutil.which("nvidia-smi")
    if not executable:
        return {"available": False}
    fields = "name,driver_version,memory.total,memory.used,utilization.gpu,power.draw,power.limit,temperature.gpu,clocks.current.sm"
    try:
        result = subprocess.run([executable, "--query-gpu=" + fields, "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, timeout=10,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        return {"available": result.returncode == 0, "fields": fields.split(","), "rows": result.stdout.strip().splitlines()}
    except (OSError, subprocess.TimeoutExpired):
        return {"available": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backends", nargs="+", choices=("mlx", "gguf", "bf16"),
                        default=["gguf", "bf16"] if os.name == "nt" else ["mlx", "gguf"])
    parser.add_argument("--repeats", type=int, default=2, help="每段热机重复次数，默认 2，另有一条首轮样本")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("--repeats 应为 1 至 10")
    output = (args.output or ROOT / "voice-benchmarks" / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
    output.mkdir(parents=True, exist_ok=False)
    source = ROOT / "assets/voice/benchmark-cases.json"
    cases = json.loads(source.read_text(encoding="utf-8"))["cases"]
    manifest = json.loads((ROOT / "assets/voice/qwen-models.json").read_text(encoding="utf-8"))
    report = {"createdAt": datetime.now().astimezone().isoformat(), "complete": False,
              "platform": {"system": platform.system(), "release": platform.release(),
                           "architecture": platform.machine(), "python": platform.python_version(), "cpuCount": os.cpu_count()},
              "gpuBefore": nvidia_snapshot(), "casesSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "referenceSha256": hashlib.sha256((PROFILE / "reference.wav").read_bytes()).hexdigest(),
              "cases": cases, "runs": [], "backends": [],
              "method": "Sequential resident backends; no audio result cache. First request includes process/model initialization; warm runs reuse the model. Same reference, seed 42, sampling and pitch-preserving postprocessing. No first-packet streaming claim."}

    def save():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for kind in dict.fromkeys(args.backends):
        backend = {"id": kind, "model": manifest["cuda" if kind == "bf16" else kind], "status": "running"}
        report["backends"].append(backend)
        speech = QwenSpeech(ROOT / "models", backend=kind)
        try:
            if not speech.installed():
                raise RuntimeError(f"{kind} 尚未准备好，请运行 scripts/setup_voice.py --backend {kind}。")
            jobs = [("first", 0, cases[0])] + [("warm", repeat, case) for repeat in range(1, args.repeats + 1) for case in cases]
            for phase, repeat, case in jobs:
                print(f"[{kind}] {phase} {repeat} / {case['id']} …", flush=True)
                started = time.perf_counter()
                audio = speech.speak(case["text"], use_cache=False)
                elapsed = time.perf_counter() - started
                metrics = dict(speech.last_metrics)
                name = f"{kind}-{phase}-{repeat}-{case['id']}.wav"
                (output / name).write_bytes(audio)
                duration = metrics["audioMs"] / 1000
                raw_duration = metrics["rawAudioMs"] / 1000
                run = {"backend": kind, "phase": phase, "repeat": repeat, "caseId": case["id"],
                       "seconds": elapsed, "audioSeconds": duration, "rawAudioSeconds": raw_duration,
                       "rtf": elapsed / duration, "rawRtf": elapsed / raw_duration, "audio": name,
                       "sha256": hashlib.sha256(audio).hexdigest(), "metrics": metrics, "gpuAfter": nvidia_snapshot()}
                report["runs"].append(run)
                save()
                print(f"  总耗时 {elapsed:.2f}s；加载 {metrics['loadMs'] / 1000:.2f}s；合成 {metrics['synthesisMs'] / 1000:.2f}s；音频 {duration:.2f}s；RTF {run['rtf']:.2f}", flush=True)
            warm = [r for r in report["runs"] if r["backend"] == kind and r["phase"] == "warm"]
            backend.update(status="complete", warmMedianSeconds=statistics.median(r["seconds"] for r in warm),
                           warmWeightedRtf=sum(r["seconds"] for r in warm) / sum(r["audioSeconds"] for r in warm))
        except Exception as exc:
            backend.update(status="failed", error=str(exc))
            print(f"[{kind}] 未完成：{exc}", file=sys.stderr, flush=True)
        finally:
            speech.close()
            save()
    report["complete"] = all(b["status"] == "complete" for b in report["backends"])
    save()
    fields = ["backend", "phase", "repeat", "caseId", "seconds", "audioSeconds", "rawAudioSeconds", "rtf", "rawRtf", "audio"]
    with (output / "timings.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(report["runs"])
    (output / "说明.txt").write_text("这是本机实际语音合成对比，使用固定虚构文字。\nfirst 包含模型加载；warm 不含首次加载；所有请求绕过成品缓存。\nRTF = 总耗时 / 成品时长，rawRtf 使用未经变速的时长。\n比较速度前也请听 WAV，检查音色、漏字、卡顿。\n可把本目录对应的 ZIP 发回审查；其中不含课堂资料、密钥或录音。\n", encoding="utf-8")
    archive = shutil.make_archive(str(output), "zip", output)
    print(f"结果：{output}\n可分享压缩包：{archive}", flush=True)
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
