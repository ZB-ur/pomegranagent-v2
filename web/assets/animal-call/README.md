# 装修小伙伴随机音效

与鸭鸭沿用同一规则：每条 AI 回复有 35% 概率插入一次，句首/句尾各半，同页重听复用选择。音效不进入文字记录；操作提示、固定收尾及日记朗读不插入。

| 预设 | 来源 | 采用片段 | 输出长度（含衔接空白） |
| --- | --- | --- | --- |
| 虎皮鹦鹉 | [Budgies5 — Mistovermoon](https://freesound.org/people/Mistovermoon/sounds/437327/) | 25.26–25.67 秒 | 0.50 秒 |
| 仓鼠 | [hamster2.wav — ondrosik](https://freesound.org/people/ondrosik/sounds/165906/) | 33.27–33.78 秒 | 0.60 秒 |

两者来源均为 CC0 1.0，使用 Freesound 页面公开的 HQ MP3 预览转制。仓鼠实录未标明品种，作为金丝熊装修的仓鼠音效，不宣称已核实为金丝熊叫声。完整来源保留于本地忽略目录 `.acceptance/audio-presets/`。

输出单声道、24kHz、16bit WAV；去直流、500Hz 低频抑制、鹦鹉 5.6kHz / 仓鼠 7.2kHz 高频柔化、12ms 淡入淡出，不变速、不改音高。以已有中文试听正文 RMS 为参考，目标分别低 7dB / 10dB，峰值上限 -13dBFS；最终约 -32.85 / -33.00dBFS RMS。句首版本末尾、句尾版本开头各留 90ms 空白。参数与成品 SHA-256 见各子目录 `provenance.json`。

试听入口：运行应用后打开 `/animal-call-preview.html`，或教师设置 → 日记本装修 → 试听三个小伙伴的随机音效。页面提供独立音效、句首、句尾及原规则随机试听，正文沿用已保存的教师声音设置。听感待用户设备试听确认。
