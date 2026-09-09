# 鸭鸭 IP：2D 绘本版


## 2026-09-09：补充四个陪伴姿态

正式应用新增 `web/assets/duck-poses/` 下的 listening、acknowledging、writing、inviting 四张 PNG，对应倾听、回应准备时接纳、处理时写日记、轮到儿童开口。使用既有四联图作为身份参考；原图和原型保持不变。四图使用暖米色实底与页面融合，非透明 PNG；预加载后切换，尊重减少动态效果设置。

初次生成的背景含棋盘格，已用内置 imagegen 修正为暖米色背景；没有将棋盘格当作透明图交付。

实际生成提示词：共用下段，并分别追加对应姿态描述。

```
Use case: illustration-story. Create ONE square full-body character pose asset for the existing children's duck diary app. Reference image is the identity/style reference only, a sheet of four poses: output ONE duck, not a sheet. Preserve exactly this ivory-white round duck with large thin charcoal circular glasses, orange bill and webbed feet, warm golden diary with tiny duck and pencil cover motif, same soft gouache/colored-pencil texture. Entire duck including crest and feet visible, centered x=50%, feet at y=90%, top of crest near y=9%; body occupies about 80% of square height, consistent proportions. Truly transparent background with alpha; no checkerboard, scenery, captions, letters or watermark. Warm attentive companion, not exaggerated cartoon.
```

- `listening.png`: Lean forward very slightly toward the child, tilt head and gently cup one wing beside the ear, other wing holds closed golden diary. Eyes looking warmly at viewer, bill closed, attentive listening.
- `acknowledging.png`: A small gentle nod: head slightly lowered, eyes warmly focused on viewer, restrained friendly closed-bill smile, both wings cradle the closed golden diary. Express understanding, not excited celebration or a thumbs-up.
- `writing.png`: Look gently down toward an open golden diary held at chest/belly, one wing holding a small pencil touching its page, as if carefully noting the child's words. Glasses recognizable; feet stay in same position. No readable text on pages.
- `inviting.png`: Look up directly toward child/viewer, relaxed head tilted slightly, bill softly closed in a welcoming smile; one wing extends gently palm-up at waist height inviting the child to speak, other wing holds closed golden diary. No waving celebration.

背景修正提示词（分别引用对应初稿）：

```
Edit this existing illustration only: replace the entire gray checkerboard background with one perfectly uniform flat warm ivory color #FFF6E8. No checkerboard, no pattern, no border. Keep the duck's exact appearance, pose, glasses, diary, texture, proportions, framing and size unchanged. Output one square image. Do not add text or other objects. Opaque flat-color background is intentional.
```


## 素材与使用

- 参考：V1 `docs/design/reference/duck-ip/duck-ip-front-cutout.png` 和对应 README。
- 保留的特征：白鸭、黑色大圆框眼镜、橙嘴与脚、暖黄色日记本及封面小鸭/铅笔。
- 图像由内置 imagegen 生成；正式应用使用 [`web/assets/duck-storybook-poses.png`](../web/assets/duck-storybook-poses.png)，原型副本保留在 `prototype/assets/duck-storybook-poses.png`。V1 参考图未修改。
- 四个姿态依次为：安静抱本、侧耳倾听、开口回应、开心举翅。
- 采用 CSS 裁切姿态和轻微身体动作，语音播放事件控制回应姿态，输入状态控制倾听姿态，收尾及保存结果控制开心姿态。不是音素级口型同步。
- 正式应用在句间缓冲时保留回应姿态、暂停说话动作；短暂播放交接延迟 180 毫秒再收回姿态。2026-09-10 修复四联图淡出时先跳回抱本帧的问题：原有各姿态使用固定独立图层，只做 260 毫秒透明度过渡；状态渲染复用同一小鸭节点，非活动图层暂停动作。主回复和等待/帮助提示都保留句间姿态，不先切回空闲图。准备/书写状态稳定 220 毫秒后才显示，缓存命中导致的极短准备不闪出第三张图。复用节点时同步按钮可用状态。尊重系统减少动态效果设置。
- 最终图为不透明暖色底，页面以 multiply 混合显示；没有把绘制的棋盘格当作透明背景。第一张生成稿存在棋盘格，未用于应用。

## 原始绘制提示

Create a new original 2D children's picture-book mascot SPRITE SHEET using the attached character as an identity reference, not an edit target. One wide image, exactly 4 equal square cells in a SINGLE horizontal row, transparent background. Each cell contains the same full-body duck at identical scale, centered at the same vertical baseline, with generous transparent margin so each pose fits in its own cell, no overlaps. Four poses left to right: 1) calm friendly idle holding notebook, eyes open, beak closed; 2) listening with head gently tilted and one wing cupped toward ear, eyes attentive; 3) speaking with open smiling beak, one wing extended gently, notebook held in other wing; 4) joyful eyes curved smiling, small celebratory raised wing, notebook in other wing. Keep identity anchors: round ivory-white duck, tiny feather tuft, large charcoal round eyeglasses, black kind eyes, orange beak and webbed feet, warm golden-yellow diary with a simple little duck and pencil symbol on cover. 2D hand-painted storybook illustration with warm colored-pencil outlines, gentle gouache grain, soft honey shadows, peach cheeks. NO 3D rendering, no glossy plastic, no photoreal feathers. Consistent character shape/proportions and palette across all four cells. No text, labels, border, frame, scenery, or watermark. Transparent alpha background, not white and not checkerboard. Asset used as CSS sprite in a local child-facing app.

## 最终修订提示

Edit this sprite sheet. Preserve the SAME four duck characters and four poses, their details and watercolor pencil style. Replace ALL checkerboard pixels with a perfectly FLAT uniform warm ivory background, exactly sRGB hex #FFF6E8; no texture, gradient, shadows or checkerboard anywhere behind the characters. Tighter vertical framing: each full duck including crest and feet occupies 85% of image height, with equal top and bottom padding. All four character centers at exactly 12.5%,37.5%,62.5%,87.5% of image width. Four equal-width cells in one horizontal row, no dividers, no overlap. Wide 3:1 aspect ratio image. All characters the same size and same feet baseline. Do not change identity, poses, notebook graphics or glasses. No text, no watermark.

## 正式应用的声音

正式应用由浏览器录音、本地 SenseVoice Small 识别、DeepSeek 接话、本地 Kokoro v1.1 zh 合成中文声音。教师可选择声音和 0.85–1.25 倍语速（五档，默认 1.05 倍）。原型使用的浏览器识别及 `speechSynthesis` 仅保留为历史实现，不是正式听说服务。

AI 回应中的鼓励应具体对应孩子实际表达的观察或行动，不编造事实，不做能力评分。鸭鸭的角色感由形象、动作和柔和预录鸭叫共同表达，不要求模型在每句话添加“嘎／嘎嘎”。

- 用户选定的声音为 qubodup 的 [Duck Quack](https://freesound.org/people/qubodup/sounds/442820/)，源自 dobroide 的录音；采用柔化、降低音量后的版本。作者署名、CC BY 4.0 授权和处理说明见 [素材说明](../web/assets/duck-call/README.md)。
- 每条 AI 回复独立按 35% 概率添加一次鸭叫；触发后以相等概率放在回复开头或末尾，其余 65% 只播正文。不是每句添加，也不保证若干轮内一定出现。
- 鸭叫作为本地音频插入播放队列，与正文连接处保留 90 毫秒间隔；正文仍动态合成，不用预录回应替代真实 AI。
- 同一页面内重听同一条回复保持相同选择；固定操作提示与故事朗读不加鸭叫，记录不增加鸭叫文字。
- 对比试听页保留在 [`web/quack-preview.html`](../web/quack-preview.html)，只使用固定虚构句子比较音色，不代表真实 AI 对话验收。

2026-09-09，用户确认所选柔和鸭叫并验收当前版本。该确认不扩展为未有独立证据的 Windows 或其他设备验收；分别验收结果见 [README](../README.md)。

## 幼儿示例头像

文件：`prototype/assets/demo-child-avatars.png`。内置 imagegen 新绘的四个虚构儿童，不代表实际幼儿。正式使用应由教师配置稳定的儿童照片。

绘制提示：Create one square 2-by-2 grid sprite sheet of four DISTINCT fictional Chinese preschool children's avatar illustrations, friendly warm children's picture-book colored-pencil and gouache style. Each quadrant is exactly the same size, a head-and-shoulders portrait centered at 25%/75% horizontal and vertical coordinates. Large recognizable faces taking 75% of each cell, equal scale, generous clean gaps, no touching neighboring cells, no grid lines. Top left: young boy with short rounded dark hair, ochre yellow shirt. Top right: young girl with two short pigtails, coral red shirt. Bottom left: young girl with a short straight bob and green shirt. Bottom right: young boy with slightly curly dark hair and soft blue shirt. Simple clear distinct hairstyles, warm smiles, natural childlike proportions, subtle paper texture in the drawing. The children are entirely fictional, not based on real children. Entire background uniform warm ivory #FFF6E8, no gradients, no checkerboard, no text, no labels, no watermarks. Intended as large selectable sample avatars in a local preschool app, not photos.
