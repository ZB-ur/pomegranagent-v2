"""Maintainer command: regenerate bundled, synthetic Qwen guidance locally.

These files ship with the app. Normal setup/start never synthesizes this list.
"""
from pathlib import Path
import hashlib
import io
import json
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.qwen_voice import QwenSpeech, PROFILE, VOICE

THINKING = ["嗯，让我想想。", "我来想一想呀。", "等我一下下。", "让我想一下哦。", "嗯，稍等一下。",
            "我想想怎么说。", "给我一点点时间。", "嗯，我正在想呢。", "我来想一想哦。", "稍等我一会儿呀。"]
GUIDES = ["找到自己的头像，来和我聊聊吧。", "你的故事讲好啦，我帮你记下来。",
          "你的故事讲好啦，我帮你记下来。还想说，按空格。", "记好啦！请下一位小朋友来吧。",
          "还没有安排小朋友，请老师先帮忙安排一下吧。", "还没有记好，故事还在。请老师帮忙，再试一次。",
          "用方向键找到自己的头像，按回车，就是你啦。", "按一下空格开始说，说完再按一下。想结束，选小本子。点我，或者按 F1，可以再听一遍。",
          "这里都是记下来的故事。点每段故事的小喇叭，就可以听。", "按回车选下一位小朋友。按 F1，可以再听一遍。",
          "正在准备声音。", "还没准备好保存故事，请老师检查本机服务。",
          "等得有点久了，可以请老师帮忙，按 Tab 选择安全退出。",
          "等得有点久了。请老师帮忙，按回车选择安全退出。",
          "可以继续等，也可以请老师保留草稿，先退出。退出不会记为完成。",
          "继续等待。按回车选择。", "保留草稿并退出。按回车选择。"]


def main():
    target = ROOT / "web/assets/voice" / VOICE
    target.mkdir(parents=True, exist_ok=True)
    manifest = target / "manifest.json"
    existing = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
    profile_hash = hashlib.sha256((PROFILE / "profile.json").read_bytes()).hexdigest()
    engine = QwenSpeech(ROOT / "models")
    output = {"voice": VOICE, "profileSha256": profile_hash, "thinking": [], "guides": [],
              "provenance": "Generated locally from the synthetic reference selected on 2026-11-17; no children's recordings."}
    try:
        for kind, texts in (("thinking", THINKING), ("guides", GUIDES)):
            for index, text in enumerate(texts, 1):
                filename = f"{'thinking' if kind == 'thinking' else 'guide'}-{index:02}.wav"
                path = target / filename
                old = next((x for x in existing.get(kind, []) if x["file"] == filename and x["text"] == text), None)
                if old and existing.get("profileSha256") == profile_hash and path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == old["sha256"]:
                    row = old
                else:
                    t = time.monotonic()
                    audio = engine.speak(text)
                    seconds = time.monotonic() - t
                    with wave.open(io.BytesIO(audio)) as wav:
                        duration = wav.getnframes() / wav.getframerate()
                    path.write_bytes(audio)
                    row = {"file": filename, "text": text, "sha256": hashlib.sha256(audio).hexdigest(),
                           "audioSeconds": round(duration, 4), "preparationSeconds": round(seconds, 3),
                           "metrics": engine.last_metrics}
                    print(json.dumps(row, ensure_ascii=False), flush=True)
                output[kind].append(row)
                manifest.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    finally:
        engine.close()


if __name__ == "__main__":
    main()
