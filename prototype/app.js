import { SpeechInput, handlesSpace } from './speech.mjs';
import { loadData, rosterFor, dateKey, recordDate } from './store.mjs';

const $ = selector => document.querySelector(selector);
const DRAFT_KEY = 'penegranagent-v2:prototype:child-drafts';
const RECORDS_KEY = 'penegranagent-v2:prototype:records';
// The teacher prototype supplies a shared roster when opened through its entry.
const rosterParam = new URLSearchParams(location.search).get('roster');
const teacherLinked = Boolean(rosterParam);
const activityDate = /^\d{4}-\d{2}-\d{2}$/.test(rosterParam ?? '') ? rosterParam : dateKey();
const demoChildren = [
  {id:'demo-mumu',name:'沐沐',avatar:0},
  {id:'demo-duoduo',name:'朵朵',avatar:1},
  {id:'demo-nuannuan',name:'暖暖',avatar:2},
  {id:'demo-yangyang',name:'阳阳',avatar:3},
];
const opening = '今天，你和小鸭一起做了什么呀？';
const examples = [
  { child: '我给小鸭换了水。原来的水有一点脏，我换了干净的水。', reply: '你给小鸭换上了干净的水。后来，小鸭做了什么呀？' },
  { child: '它走过来喝水了，嘴巴一下一下的。', reply: '你还看见它一下一下地喝水呀。还有想告诉我的事吗？' },
  { child: '我明天还想来看它。', reply: '你明天还想来看它呀。你还可以继续说，也可以点小本子，把今天记下来。' },
];
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
let records = read(RECORDS_KEY, []);
let drafts = read(DRAFT_KEY, {});
let draft = null;
let child = null;
let rosterSize = 3;
const currentRoster = () => teacherLinked ? rosterFor(loadData(),activityDate) : demoChildren.slice(0,rosterSize);
let rosterFocus = 0;
let focusTimer;
let screen = 'roster';
let mode = 'demo'; // Microphone use is explicit, never an unattended default.
let capture = 'idle';
let liveText = draft?.pendingText ?? '';
let prompt = draft?.turns.filter(turn => turn.role === 'system').at(-1)?.text ?? opening;
let guide = '';
let speaking = false;
let speechEpoch = 0;
let currentUtterance;
let demoIndex = draft?.turns.filter(turn => turn.role === 'child').length ?? 0;
let demoTimer;
let noticeTimer;
let soundUnlocked = false;
const words = () => (draft?.turns ?? []).filter(turn => turn.role === 'child').map(turn => turn.text);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const dateLabel = value => new Date(value).toLocaleDateString('zh-CN', { month:'long', day:'numeric' });
function notify(text) {
  $('#notice').textContent = text; $('#notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 6500);
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { notify('当前浏览器无法保存，请老师先复制记录内容。'); return false; }
}
function syncDraft() {
  if (draft?.child) { drafts[draft.child.id] = draft; write(DRAFT_KEY, drafts); }
}
function avatar(person, className = '') {
  if (person.photo) return `<img class="child-avatar uploaded-avatar ${className}" src="${escape(person.photo)}" alt="">`;
  if (person.avatar == null) return `<span class="child-avatar placeholder ${className}" aria-hidden="true">${escape(person.name?.slice(-1)||"＋")}</span>`;
  return `<span class="child-avatar avatar-${person.avatar} ${className}" aria-hidden="true"></span>`;
}
function childStatus(person) {
  const pending = drafts[person.id];
  if (pending?.pendingText || pending?.turns.some(turn => turn.role === 'child')) return '还有话想说';
  return records.some(record => record.child?.id === person.id && recordDate(record) === activityDate) ? '今天已记好' : '轮到我讲故事';
}
function selectChild(id) {
  child = currentRoster().find(person => person.id === id);
  if (!child) return;
  draft = drafts[child.id] ?? null;
  if (!draft) { start(); return; }
  liveText = draft.pendingText ?? '';
  prompt = draft.turns.filter(turn => turn.role === 'system').at(-1)?.text ?? opening;
  demoIndex = words().length;
  go('conversation');
}
function returnToRoster() {
  if (capture !== 'idle') {
    clearTimeout(demoTimer); silence();
    if (mode === 'voice') input.cancel();
    capture = 'idle'; syncDraft();
    render();
    say('已经停止听了，刚才的文字还在。想回到头像选择，再按一下退出键。');
    return;
  }
  syncDraft();
  if (screen === 'saved') {
    const roster = currentRoster();
    for (let offset = 1; offset <= roster.length; offset++) {
      const index = (rosterFocus + offset) % roster.length;
      if (childStatus(roster[index]) !== '今天已记好') { rosterFocus = index; break; }
    }
  }
  child = null; draft = null; liveText = ''; go('roster');
}
function icon(name) {
  const paths = {
    mic:'<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    book:'<path d="M4 4h7a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM14 7a3 3 0 0 1 3-3h4v15h-3a4 4 0 0 0-4 2"/>',
    sound:'<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16"/>',
    check:'<path d="m5 12 4 4L20 5"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
function mascot(state = 'idle', small = false) {
  return `<button class="mascot ${small ? 'small' : ''}" data-mood="${state}" aria-label="听鸭鸭再说一遍"><span class="mascot-glow"></span><span class="duck-sprite"></span><span class="duck-shadow"></span><span class="sound-tag">${icon('sound')}</span></button>`;
}
function mood() {
  return speaking ? 'speaking' : ['listening','starting'].includes(capture) ? 'listening' : ['saved','review'].includes(screen) ? 'happy' : 'idle';
}
function refreshMood() {
  document.querySelectorAll('.mascot').forEach(el => { el.dataset.mood = mood(); });
  $('#voice-status').textContent = speaking ? '鸭鸭正在说话' : soundUnlocked ? '语音引导已开启' : '点小鸭，听语音引导';
}
function silence() {
  speechEpoch++; window.speechSynthesis?.cancel(); currentUtterance = null; speaking = false; refreshMood();
}
function say(text, onDone) {
  guide = text; silence(); const epoch = speechEpoch;
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    $('#voice-status').textContent = '此浏览器无法播放引导，请教师协助'; onDone?.(); return;
  }
  const utterance = currentUtterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN'; utterance.rate = 0.88; utterance.pitch = 1.08;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find(v => /^zh[-_]CN/i.test(v.lang) && v.localService) ?? voices.find(v => /^zh/i.test(v.lang)) ?? null;
  utterance.onstart = () => { if (epoch !== speechEpoch) return; soundUnlocked = true; speaking = true; refreshMood(); };
  utterance.onend = () => { if (epoch !== speechEpoch) return; speaking = false; currentUtterance = null; refreshMood(); onDone?.(); };
  utterance.onerror = event => {
    if (epoch !== speechEpoch) return;
    speaking = false; refreshMood();
    if (event.error === 'not-allowed') $('#voice-status').textContent = '点小鸭，听语音引导';
    else if (!['interrupted','canceled'].includes(event.error)) $('#voice-status').textContent = '点小鸭重听；若无声音，请老师检查音量';
    onDone?.();
  };
  speechSynthesis.speak(utterance);
}
function stepGuide() {
  if (screen === 'roster' && !currentRoster().length) return '还没有安排小朋友，请老师先帮忙安排一下吧。';
  if (screen === 'roster') return '今天轮到你们照顾小鸭啦。找到自己的头像，用方向键选一选，按回车就可以和我说话。';
  if (screen === 'conversation') return `${child.name}，你好呀。${prompt} 按一下空格键，开始说话。说完以后，再按一下。今天讲好了，用方向键选小本子，再按回车。`;
  if (screen === 'review') return '你的故事记下来啦。用方向键选择小喇叭，按回车，我就读给你听。还想补充，可以选我还想说。看好了，选记下今天，按回车。';
  if (screen === 'saved') return `${child.name}，记好啦！按回车，回到大家的头像，让下一位小朋友来讲吧。`;
  return '这里都是记下来的故事。点每段故事的小喇叭，就可以听。';
}
function go(next, announce = true) {
  clearTimeout(focusTimer); silence(); screen = next; render();
  const first = screen === 'roster' ? document.querySelectorAll('[data-child]')[rosterFocus] : screen === 'conversation' ? $('#record-toggle') : screen === 'review' ? $('#read-record') : screen === 'saved' ? $('#next-child') : $('#return-button');
  (first ?? $('#main')).focus({ preventScroll:true });
  guide = stepGuide(); if (announce) say(guide);
}
function start() {
  if (!child) { go('roster'); return; }
  draft = { id:crypto.randomUUID(), child:{...child}, activityDate, createdAt:new Date().toISOString(), turns:[{role:'system',text:opening}], pendingText:'' };
  demoIndex = 0; liveText = ''; prompt = opening; syncDraft(); go('conversation');
}
function transcript(turns) { return turns.map(turn => `<div class="transcript-line"><span>${turn.role === 'child' ? '孩子' : '鸭鸭'}</span><p>${escape(turn.text)}</p></div>`).join(''); }
function render() {
  const focusedId = document.activeElement?.id;
  $('#record-count').textContent = records.length;
  $('#history-button').disabled = capture !== 'idle';
  $('#mode-select').disabled = capture !== 'idle'; $('#mode-select').value = mode;
  $('#roster-size').disabled = screen !== 'roster'; $('#roster-size').value = String(rosterSize);
  $('#roster-size').hidden = teacherLinked;
  $('#sample-button').disabled = screen !== 'conversation' || capture !== 'listening' || mode !== 'demo';
  $('#demo-hint').textContent = mode === 'demo' ? '示例模式：空格启动后可加入示例；再次按空格提交。' : '浏览器语音识别可能联网；回复暂为固定引导，未接入对话 AI。';
  if (screen === 'roster') {
    const roster = currentRoster();
    $('#main').innerHTML = `<section class="selection-layout"><aside class="selection-friend">${mascot('idle',true)}<p>今天的小故事，<br>我已经准备好听啦。</p></aside><div class="selection-content"><p class="chapter">${dateLabel(activityDate+'T12:00:00')} · ${activityDate===dateKey()?'今天的小小照顾员':'排班日期预览'}</p><h1>${roster.length?'找到自己，<br class="mobile-break">来和鸭鸭聊聊。':'等老师安排好，<br>我们就可以聊啦。'}</h1><div class="roster-grid" data-count="${roster.length}">${roster.map((person,index) => `<button class="child-card" data-child="${escape(person.id)}" tabindex="${index === rosterFocus ? 0 : -1}" aria-label="${escape(person.name)}，${childStatus(person)}">${avatar(person)}<span class="child-name">${escape(person.name)}</span><span class="child-card-status">${childStatus(person) === '今天已记好' ? '✓ ' : ''}${childStatus(person)}</span></button>`).join('')}</div>${roster.length?'<div class="selection-keys"><span><kbd>← ↑ ↓ →</kbd>选自己的头像</span><span><kbd>回车 ↵</kbd>就是我</span></div>':'<a class="quiet-button" href="teacher.html#schedule">请老师安排今天的名单 →</a>'}</div></section>`;
    document.querySelectorAll('[data-child]').forEach((button,index) => {
      button.onclick = () => selectChild(button.dataset.child);
      button.onfocus = () => {
        rosterFocus = index;
        document.querySelectorAll('[data-child]').forEach(item => { item.tabIndex = item === button ? 0 : -1; });
      };
    });
  } else if (screen === 'conversation') {
    const listening = capture === 'listening' || capture === 'starting';
    const waiting = capture === 'stopping';
    $('#main').innerHTML = `<section class="child-scene"><div class="friend-column"><p class="eyebrow">${listening ? '我在认真听' : '鸭鸭一直陪着你'}</p>${mascot(mood())}<span class="friend-caption">${listening ? '想一想也没关系' : '点点我，听我再说一遍'}</span></div><div class="talk-column"><div class="identity-strip">${avatar(child,'mini')}<strong>${child.name}正在讲故事</strong><button id="switch-child" class="text-button">换个人 · Esc</button></div><div class="status-pill ${listening ? 'live' : ''}"><span></span>${capture === 'starting' ? '正在打开麦克风' : capture === 'cue' ? '听完这句话，就轮到你' : listening ? '轮到你说啦' : waiting ? '把这句话记下来' : '我们接着聊'}</div><h1 class="conversation-prompt">${escape(prompt)}</h1><div class="heard"><span>${listening ? '我听见你说' : liveText ? '刚才还没说完的' : '你刚才说'}</span><p id="live-text">${escape(liveText || words().at(-1) || '说一点点，也可以。')}</p></div><button id="record-toggle" class="primary ${listening ? 'recording' : ''}" ${waiting ? 'disabled' : ''}>${icon(listening ? 'stop' : 'mic')}<span>${listening ? '说好了，按一下' : capture === 'cue' ? '准备好，再开口' : waiting ? '等我一下' : '我来说一说'}</span></button><div class="keyboard-cue"><kbd>空格</kbd><span>${listening ? '再按一下，停止说话' : '按一下，开始说话'}</span></div><button id="finish-button" class="finish-button" ${capture !== 'idle' || !words().length ? 'disabled' : ''}>${icon('book')}<span>今天讲好啦</span><span>→</span></button></div></section>`;
    $('#record-toggle').onclick = toggleCapture;
    $('#switch-child').onclick = returnToRoster;
    $('#finish-button').onclick = () => { if (draft.editedText === undefined) draft.editedText = words().join('\n\n'); syncDraft(); go('review'); };
  } else if (screen === 'review') {
    $('#main').innerHTML = `<section class="review-layout"><div class="review-friend">${mascot('happy',true)}<h1>你的故事，<br>记下来啦。</h1><button class="quiet-button" id="continue-button">← 我还想说</button></div><article class="paper"><div class="paper-heading"><span>${escape(child.name)}的鸭鸭日记</span><time>${dateLabel(draft.createdAt)}</time></div><div class="paper-title"><h2>我和小鸭的一天</h2><button class="read-button" id="read-record" aria-label="听鸭鸭读这篇记录">${icon('sound')}</button></div><label for="record-text">和老师一起看一看</label><textarea id="record-text" rows="5">${escape(draft.editedText)}</textarea><details><summary>对话原文</summary>${transcript(draft.turns)}</details><button class="primary full" id="save-button">${icon('check')}记下今天</button><p class="storage-note">当前浏览器保存 · 原型记录</p></article></section>`;
    $('#record-text').oninput = event => { draft.editedText = event.target.value; syncDraft(); };
    $('#read-record').onclick = () => say(draft.editedText.trim() || '这里还没有故事，和老师一起写一点吧。');
    $('#continue-button').onclick = () => go('conversation'); $('#save-button').onclick = save;
  } else if (screen === 'saved') {
    $('#main').innerHTML = `<section class="child-scene"><div class="friend-column">${mascot('happy')}</div><div class="talk-column"><p class="chapter">又多了一个温暖的小故事</p><h1>记好啦，<br>下次再聊！</h1><p class="support">我会在这里，等你的新故事。</p><button class="primary" id="next-child">下一位小朋友<span>→</span></button><button class="quiet-button new-story" id="open-records">听听${child.name}的故事</button></div></section>`;
    $('#open-records').onclick = () => go('history'); $('#next-child').onclick = returnToRoster;
  } else {
    $('#main').innerHTML = `<section class="history-layout"><aside>${mascot('idle',true)}<h1>我们的小故事</h1><button class="quiet-button" id="return-button">${draft ? '回去继续聊 →' : '回到今日头像 →'}</button></aside><div class="record-list">${records.length ? records.map(record => `<article class="paper history-paper"><div class="paper-heading"><span>${escape(record.child?.name ?? '旧版示例')}的鸭鸭日记</span><time>${dateLabel(record.createdAt)}</time></div><div class="paper-title"><h2>我和小鸭的一天</h2><button class="read-button" data-record="${escape(record.id)}" aria-label="听这篇故事">${icon('sound')}</button></div><p class="record-body">${escape(record.text)}</p><details><summary>对话原文</summary>${transcript(record.turns)}</details></article>`).join('') : '<div class="empty-state"><h2>第一段故事，还在等你。</h2><p>和鸭鸭聊一聊，就会有自己的故事啦。</p></div>'}</div></section>`;
    $('#return-button').onclick = () => draft ? go('conversation') : returnToRoster();
    document.querySelectorAll('[data-record]').forEach(button => { button.onclick = () => say(records.find(record => record.id === button.dataset.record).text); });
  }
  document.querySelectorAll('.mascot').forEach(button => { button.onclick = () => {
    if (capture !== 'idle') { notify('正在听你说话，再按空格停止后，鸭鸭就能开口啦。'); return; }
    say(guide || stepGuide());
  }; });
  if (focusedId) document.getElementById(focusedId)?.focus({preventScroll:true});
  refreshMood();
}
const input = new SpeechInput({
  Recognition:window.SpeechRecognition || window.webkitSpeechRecognition,
  onState:state => { capture = state; render(); },
  onText:text => { liveText = text; draft.pendingText = text; syncDraft(); if ($('#live-text')) $('#live-text').textContent = text; },
  onCommit:text => { liveText = ''; draft.pendingText = ''; text ? addTurn(text) : noWords(); },
  onError:(error,text) => {
    liveText = text || liveText; if (draft) { draft.pendingText = liveText; syncDraft(); }
    const message = error === 'unsupported' ? '这个浏览器还不能听你说话，请老师帮忙换一个支持语音的浏览器。' : ['not-allowed','service-not-allowed'].includes(error) ? '麦克风还没有打开，请老师帮一下忙。刚才的文字我先留着。' : '刚才没有听清，已经听见的文字还在。请老师帮忙检查一下，再按空格试试。';
    render(); notify(message); say(message);
  },
});
function noWords() { syncDraft(); render(); say('我还没有听见你的话，没关系。按一下空格，再试一试。'); }
function toggleCapture() {
  if (screen !== 'conversation' || capture === 'stopping') return;
  if (capture === 'cue') { silence(); capture = 'idle'; render(); return; }
  if (capture !== 'idle') {
    if (mode === 'voice') input.stop();
    else { clearTimeout(demoTimer); capture = 'idle'; const text = liveText; liveText = ''; draft.pendingText = ''; text ? addTurn(text,examples[(demoIndex - 1 + examples.length) % examples.length]?.reply) : noWords(); }
    return;
  }
  silence(); capture = 'cue'; render();
  // Speak before capture so the recognizer cannot hear its own instructions.
  say('我在听啦。说完，再按一下空格。', () => {
    if (capture !== 'cue' || screen !== 'conversation') return;
    if (mode === 'voice') { capture = 'idle'; input.start(liveText); }
    else { capture = 'listening'; render(); demoTimer = setTimeout(addDemoText,1400); }
  });
}
function addDemoText() {
  if (mode !== 'demo' || capture !== 'listening' || liveText) return;
  const example = examples[demoIndex % examples.length]; demoIndex = (demoIndex % examples.length) + 1;
  liveText = example.child; draft.pendingText = liveText; syncDraft(); $('#live-text').textContent = liveText;
}
function addTurn(text,demoReply) {
  prompt = demoReply || '我把你刚才说的话记下来了。还有想告诉我的事吗？';
  draft.turns.push({role:'child',text},{role:'system',text:prompt});
  if (draft.editedText !== undefined) draft.editedText += '\n\n' + text;
  syncDraft(); render(); say(`${prompt} 想继续说，就再按一下空格。今天讲好了，就点小本子。`);
}
function save() {
  const text = draft.editedText.trim();
  if (!text) { say('这里还没有故事，和老师一起写一点再保存吧。'); $('#record-text').focus(); return; }
  const record = {id:draft.id,child:{...draft.child},activityDate:draft.activityDate ?? dateKey(new Date(draft.createdAt)),createdAt:draft.createdAt,text,turns:draft.turns};
  const updated = [record,...records.filter(item => item.id !== record.id)];
  if (!write(RECORDS_KEY,updated)) return;
  records = updated; delete drafts[child.id]; write(DRAFT_KEY,drafts);
  draft = null; go('saved');
}
// Prevent a held key from scrolling while still issuing just one toggle.
let spaceHeld = false;
document.addEventListener('keyup', event => { if (event.code === 'Space') spaceHeld = false; });
window.addEventListener('blur', () => { spaceHeld = false; });
document.addEventListener('keydown', event => {
  if (screen !== 'conversation') return;
  if (spaceHeld && event.code === 'Space') { event.preventDefault(); return; }
  if (!handlesSpace(event)) return;
  event.preventDefault(); spaceHeld = true; toggleCapture();
});
$('#history-button').onclick = () => screen === 'history' ? (draft ? go('conversation') : returnToRoster()) : go('history');
$('#mode-select').onchange = event => { silence(); mode = event.target.value; render(); say(mode === 'demo' ? '现在是示例体验。按空格开始，再按空格停止。' : '现在可以用麦克风说话啦。按空格开始，再按空格停止。'); };
$('#sample-button').onclick = addDemoText;
$('#roster-size').onchange = event => {
  rosterSize = Number(event.target.value); rosterFocus = 0; go('roster');
};
// Arrow navigation stays inside the child's current activity. Native Tab also works.
document.addEventListener('keydown', event => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'F1') { event.preventDefault(); if (capture === 'idle') say(stepGuide()); return; }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (screen === 'roster') { silence(); return; }
    if (screen === 'review') go('conversation');
    else if (screen === 'history' && draft) go('conversation');
    else returnToRoster();
    return;
  }
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
  if (event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
  const items = [...document.querySelectorAll(screen === 'roster' ? '[data-child]' : '#main button:not(:disabled), #main summary')];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement);
  let delta = ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1;
  if (screen === 'roster' && ['ArrowUp','ArrowDown'].includes(event.key)) {
    const columns = getComputedStyle($('.roster-grid')).gridTemplateColumns.split(' ').length;
    delta *= columns;
  }
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : current === -1 ? 0 : (current+delta+items.length)%items.length;
  const item = items[index]; item.focus(); item.scrollIntoView({block:'nearest'});
  clearTimeout(focusTimer);
  if (capture === 'idle') focusTimer = setTimeout(() => {
    if (!item.isConnected || item !== document.activeElement || capture !== 'idle') return;
    say(`${item.getAttribute('aria-label') || item.textContent.trim()}。按回车选择。`);
  }, 280);
});
window.addEventListener('pagehide', () => { clearTimeout(demoTimer); silence(); input.cancel(); });
render(); document.querySelector('[data-child]')?.focus({preventScroll:true}); guide = stepGuide(); say(guide);
