import { Recorder, Speaker, handlesSpace } from './audio.mjs';
import { loadData, rosterFor, dateKey, recordDate, read, update, api, refresh } from './store.mjs';

const $ = selector => document.querySelector(selector);
const DRAFT_KEY = 'penegranagent-v2:prototype:child-drafts';
const RECORDS_KEY = 'penegranagent-v2:prototype:records';
const activityDate = dateKey();
const opening = '今天，你和小鸭一起做了什么呀？';
let records = read(RECORDS_KEY, []);
let drafts = read(DRAFT_KEY, {});
let draft = null;
let configuredRounds=3;
let child = null;
const currentRoster = () => rosterFor(loadData(),activityDate);
let rosterFocus = 0;
let focusTimer;
let screen = 'roster';
let aiPending=false, pendingAudio=false, saving=false;
let capture = 'idle';
let replyPhase = '', replyError = false;
const interactionLocked = () => screen==='conversation' && (aiPending || saving || capture==='stopping' || Boolean(replyPhase));
let liveText = draft?.pendingText ?? '';
let prompt = draft?.turns.filter(turn => turn.role === 'assistant').at(-1)?.text ?? opening;
let guide = '';
let speaking = false, voiceError='';

let noticeTimer;
let soundUnlocked = false;
const audioKey = () => `story:${draft.id}`;
const roundLimitReached=()=>Boolean(draft&&draft.turns.filter(t=>t.role==='child').length>=(draft.conversationRounds??configuredRounds));
const words = () => (draft?.turns ?? []).filter(turn => turn.role === 'child').map(turn => turn.text);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const dateLabel = value => new Date(value).toLocaleDateString('zh-CN', { month:'long', day:'numeric' });
function notify(text) {
  $('#notice').textContent = text; $('#notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 6500);
}
let draftSave=Promise.resolve(), draftWrites=0, draftWriteEpoch=0, draftUnsaved=false, selectionEpoch=0;
function syncDraft() {
  if(!draft?.child)return Promise.resolve();
  const snapshot=structuredClone(draft),key=draft.child.id;
  const epoch=++draftWriteEpoch;draftUnsaved=true;
  drafts[key]=snapshot;
  draftWrites++;
  draftSave=update(next=>{next.drafts[key]=snapshot;}).then(result=>{if(epoch===draftWriteEpoch)draftUnsaved=false;return result;}).finally(()=>{draftWrites--;});
  draftSave.catch(e=>notify('草稿还没保存到本机，请先不要关闭。'+e.message));
  return draftSave;
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
async function selectChild(id) {
  if(screen!=='roster')return;
  const epoch=++selectionEpoch;
  const current=()=>epoch===selectionEpoch&&screen==='roster';
  try {
    if(!await refresh(current)||!current())return;
    records=read(RECORDS_KEY,[]);drafts=read(DRAFT_KEY,{});
    const config=await api('settings',undefined,'GET');if(!current())return;configuredRounds=config.conversationRounds??3;
    const person=currentRoster().find(person=>person.id===id);
    if(!person){rosterFocus=0;go('roster');say('老师更新了今天的名单。我们重新选一下自己的头像吧。');return;}
    const existing=drafts[id]??null;
    if(existing)await input.migratePending(id,`story:${existing.id}`);
    const hasAudio=existing?await input.hasPending(`story:${existing.id}`):false;
    if(!current())return;
    child=person;draft=existing;pendingAudio=hasAudio;replyError=false;
    if(draft)draft.conversationRounds??=configuredRounds;
    if(!draft){await start();return;}
    liveText=draft.pendingText??'';
    prompt=draft.turns.filter(turn=>turn.role==='assistant').at(-1)?.text??opening;
    go('conversation');
  } catch(error) {
    if(!current())return;
    notify(error.message);say('还没有打开你的故事，请老师检查一下，再选自己的头像。');
  }
}
async function returnToRoster() {
  if(interactionLocked())return;
  if (capture !== 'idle') { if(capture==='listening')input.stop();else {silence();await input.cancel();capture='idle';render();} return; }
  try { await syncDraft(); } catch {return;}
  if (screen === 'saved') {
    const roster = currentRoster();
    for (let offset = 1; offset <= roster.length; offset++) {
      const index = (rosterFocus + offset) % roster.length;
      if (childStatus(roster[index]) !== '今天已记好') { rosterFocus = index; break; }
    }
  }
  ++selectionEpoch;child = null; draft = null; liveText = '';pendingAudio=false;
  try{await refresh();records=read(RECORDS_KEY,[]);drafts=read(DRAFT_KEY,{});}catch{notify('暂时无法更新名单，请老师检查本机服务。');}
  rosterFocus=Math.min(rosterFocus,Math.max(0,currentRoster().length-1));go('roster');
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
  return speaking ? 'speaking' : interactionLocked() ? 'thinking' : capture === 'listening' ? 'listening' : ['saved','review'].includes(screen) ? 'happy' : 'idle';
}
function refreshMood() {
  document.querySelectorAll('.mascot').forEach(el => { el.dataset.mood = mood(); });
  $('#voice-status').textContent = voiceError || (replyPhase==='preparing'?'正在准备鸭鸭的声音':speaking ? '鸭鸭正在说话' : soundUnlocked ? '语音引导已开启' : '点小鸭，听语音引导');
}
const speaker = new Speaker(value=>{speaking=value;if(value){soundUnlocked=true;voiceError='';}refreshMood();},message=>{voiceError='声音未就绪 · 请老师帮忙';notify(message);$('#voice-status').textContent=voiceError;if(capture==='cue'){capture='idle';render();}});
function silence(){speaker.stop();}
function say(text,onDone){guide=text;if(capture==='listening')return;speaker.speak(text,onDone);}
function stepGuide() {
  if (screen === 'roster' && !currentRoster().length) return '还没有安排小朋友，请老师先帮忙安排一下吧。';
  if (screen === 'roster') return '今天轮到你们照顾小鸭啦。找到自己的头像，用方向键选一选，按回车就可以和我说话。';
  if(screen==='conversation'&&pendingAudio)return '你上次说的声音还在。请老师检查服务后，用方向键选重新听这段，再按回车。';
  if(screen==='conversation'&&roundLimitReached())return draft.aiError?'你的话已经留好了。选请鸭鸭再接着说，听完我们就记故事。':`${prompt} 用方向键选小本子，按回车，一起核对故事。`;
  if (screen === 'conversation') return `${child.name}，你好呀。${prompt} 按一下空格键，开始说话。说完以后，再按一下。今天讲好了，用方向键选小本子，再按回车。`;
  if (screen === 'review') return '我们一起听听你的故事吧。用方向键选择小喇叭，按回车，我就读给你听。'+(roundLimitReached()?'需要修改，请老师帮忙核对。':'还想补充，可以选我还想说。')+'看好了，选记下今天，按回车。';
  if (screen === 'saved') return `${child.name}，记好啦！按回车，回到大家的头像，让下一位小朋友来讲吧。`;
  return '这里都是记下来的故事。点每段故事的小喇叭，就可以听。';
}
function go(next, announce = true) {
  clearTimeout(focusTimer); silence(); screen = next; render();
  const first = screen === 'roster' ? document.querySelectorAll('[data-child]')[rosterFocus] : screen === 'conversation' ? (roundLimitReached()?($('#retry-ai')??$('#finish-button')):$('#record-toggle')) : screen === 'review' ? $('#read-record') : screen === 'saved' ? $('#next-child') : $('#return-button');
  (first ?? $('#main')).focus({ preventScroll:true });
  guide = stepGuide(); if (announce) say(guide);
}
async function start() {
  if (!child) { go('roster'); return; }
  draft = { id:crypto.randomUUID(), child:{...child}, activityDate, conversationRounds:configuredRounds, createdAt:new Date().toISOString(), turns:[{role:'assistant',text:opening}], pendingText:'' };
  liveText = ''; prompt = opening;try{await syncDraft();go('conversation');}catch{child=null;draft=null;render();say('还没准备好保存故事，请老师检查本机服务。');}
}
function transcript(turns) { return turns.map(turn => `<div class="transcript-line"><span>${turn.role === 'child' ? '孩子' : '鸭鸭'}</span><p>${escape(turn.text)}</p></div>`).join(''); }
function render() {
  const focusedId = document.activeElement?.id;
  $('#record-count').textContent = child ? records.filter(record=>record.child?.id===child.id).length : '—';
  $('#history-button').disabled = capture !== 'idle' || aiPending || saving || !child;
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
    const listening = capture === 'listening';
    const waiting = interactionLocked();
    $('#main').innerHTML = `<section class="child-scene"><div class="friend-column"><p class="eyebrow">${listening ? '我在认真听' : '鸭鸭一直陪着你'}</p>${mascot(mood())}<span class="friend-caption">${listening ? '想一想也没关系' : waiting ? (speaking?'先听我说完，再轮到你':'我会陪你一起等') : '点点我，听我再说一遍'}</span></div><div class="talk-column"><div class="identity-strip">${avatar(child,'mini')}<strong>${escape(child.name)}正在讲故事</strong><button id="switch-child" class="text-button">换个人 · Esc</button></div><div role="status" class="status-pill ${waiting&&replyPhase!=='playing'?'waiting':listening ? 'live' : ''}"><span></span>${replyPhase==='playing' ? '听鸭鸭说完，就轮到你' : replyPhase ? '正在准备鸭鸭的声音' : capture === 'starting' ? '正在打开麦克风' : capture === 'cue' ? '听完这句话，就轮到你' : listening ? '轮到你说啦' : waiting ? '把这句话记下来' : roundLimitReached() ? '今天讲好啦' : '我们接着聊'}</div><h1 class="conversation-prompt">${escape(replyPhase==='preparing'&&!prompt?'鸭鸭想好了，马上说给你听。':prompt)}</h1><div class="heard"><span>${listening ? '正在收音，停下来后再核对' : liveText ? '刚才还没说完的' : '你刚才说'}</span><p id="live-text">${escape(liveText || words().at(-1) || '说一点点，也可以。')}</p></div><button id="record-toggle" class="primary ${listening ? 'recording' : ''}" ${waiting || roundLimitReached() ? 'disabled' : ''}>${icon(listening ? 'stop' : 'mic')}<span>${listening ? '说好了，按一下' : capture === 'cue' ? '准备好，再开口' : waiting ? '等我一下' : roundLimitReached() ? '这次讲好啦' : '我来说一说'}</span></button><div class="keyboard-cue"><kbd>${roundLimitReached()?'回车':'空格'}</kbd><span>${waiting?'先听鸭鸭说，键盘休息一下':roundLimitReached()?'选小本子，核对故事':listening ? '再按一下，停止说话' : '按一下，开始说话'}</span></div><button id="finish-button" class="finish-button" ${capture !== 'idle' || aiPending || pendingAudio || !words().length ? 'disabled' : ''}>${icon('book')}<span>今天讲好啦</span><span>→</span></button>${pendingAudio&&capture==='idle'&&!aiPending?'<button id="retry-audio" class="quiet-button">重新听这段录音</button><button id="rerecord" class="quiet-button">重新说这一段</button>':''}${replyError?'<button id="retry-reply" class="quiet-button">重新听鸭鸭的回复</button>':''}${draft.aiError&&!aiPending&&capture==='idle'?'<button id="retry-ai" class="quiet-button">请鸭鸭再接着说</button>':''}</div></section>`;
    $('#record-toggle').onclick = toggleCapture;
    if($('#retry-reply'))$('#retry-reply').onclick=()=>playReply(draft);
    if($('#retry-audio'))$('#retry-audio').onclick=()=>{silence();input.retry(audioKey());};
    if($('#rerecord'))$('#rerecord').onclick=async()=>{try{if(!await input.setAside(audioKey()))return;pendingAudio=false;render();say('上一段声音先放好，按空格，重新讲这一段吧。');}catch(e){notify(e.message);}};
    if($('#retry-ai'))$('#retry-ai').onclick=()=>respond();
    $('#switch-child').onclick = returnToRoster;
    $('#finish-button').onclick = finishStory;
  } else if (screen === 'review') {
    $('#main').innerHTML = `<section class="review-layout"><div class="review-friend">${mascot('idle',true)}<h1>听听你的<br>小故事。</h1><button class="quiet-button" id="continue-button">${roundLimitReached()?'← 回去听回复':'← 我还想说'}</button></div><article class="paper"><div class="paper-heading"><span>${escape(child.name)}的鸭鸭日记</span><time>${dateLabel(draft.createdAt)}</time></div><div class="paper-title"><h2>我和小鸭的一天</h2><button class="read-button" id="read-record" aria-label="听鸭鸭读这篇记录">${icon('sound')}</button></div><label for="record-text">和老师一起看一看</label><textarea id="record-text" rows="5">${escape(draft.editedText)}</textarea><details><summary>对话原文</summary>${transcript(draft.turns)}</details><button class="primary full" id="save-button">${icon('check')}记下今天</button><p class="storage-note">保存在这台电脑 · 幼儿原话与鸭鸭发言分开留存</p></article></section>`;
    $('#record-text').oninput = event => { draft.editedText = event.target.value; syncDraft(); };
    $('#read-record').onclick = () => say(draft.editedText.trim() || '这里还没有故事，和老师一起写一点吧。');
    $('#continue-button').onclick = () => go('conversation'); $('#save-button').onclick = save;
  } else if (screen === 'saved') {
    $('#main').innerHTML = `<section class="child-scene"><div class="friend-column">${mascot('happy')}</div><div class="talk-column"><p class="chapter">又多了一个温暖的小故事</p><h1>记好啦，<br>下次再聊！</h1><p class="support">我会在这里，等你的新故事。</p><button class="primary" id="next-child">下一位小朋友<span>→</span></button><button class="quiet-button new-story" id="open-records">听听${escape(child.name)}的故事</button></div></section>`;
    $('#open-records').onclick = () => go('history'); $('#next-child').onclick = returnToRoster;
  } else {
    $('#main').innerHTML = `<section class="history-layout"><aside>${mascot('idle',true)}<h1>我们的小故事</h1><button class="quiet-button" id="return-button">${draft ? '回去继续聊 →' : '回到今日头像 →'}</button></aside><div class="record-list">${records.filter(r=>r.child?.id===child?.id).length ? records.filter(r=>r.child?.id===child?.id).map(record => `<article class="paper history-paper"><div class="paper-heading"><span>${escape(record.child?.name ?? '旧版示例')}的鸭鸭日记</span><time>${dateLabel(record.createdAt)}</time></div><div class="paper-title"><h2>我和小鸭的一天</h2><button class="read-button" data-record="${escape(record.id)}" aria-label="听这篇故事">${icon('sound')}</button></div><p class="record-body">${escape(record.text)}</p><details><summary>对话原文</summary>${transcript(record.turns)}</details></article>`).join('') : '<div class="empty-state"><h2>第一段故事，还在等你。</h2><p>和鸭鸭聊一聊，就会有自己的故事啦。</p></div>'}</div></section>`;
    $('#return-button').onclick = () => draft ? go('conversation') : returnToRoster();
    document.querySelectorAll('[data-record]').forEach(button => { button.onclick = () => say(records.find(record => record.id === button.dataset.record).text); });
  }
  document.querySelectorAll('.mascot').forEach(button => { button.onclick = () => {
    if(interactionLocked())return;
    if(replyError){playReply(draft);return;}
    if (capture !== 'idle') { notify('正在听你说话，再按空格停止后，鸭鸭就能开口啦。'); return; }
    say(guide || stepGuide());
  }; });
  document.querySelector('.demo-bar')?.toggleAttribute('inert',interactionLocked());
  if(interactionLocked()){
    document.querySelectorAll('#main button').forEach(b=>b.disabled=true);
    $('#history-button').disabled=true;
  }
  if (focusedId) document.getElementById(focusedId)?.focus({preventScroll:true});
  refreshMood();
}
const input = new Recorder({
  onState:state=>{capture=state;render();if(state==='stopping')say('已经停止听了，等我把这句话记下来。');},
  onCommit:async (text,inputId)=>{
    if(draft.turns.some(turn=>turn.inputId===inputId))return;
    const next=structuredClone(draft);next.turns.push({role:'child',text,inputId});next.pendingText='';next.aiError=true;delete next.editedText;
    await update(state=>{state.drafts[child.id]=next;});draft=next;drafts[child.id]=next;liveText='';
  },
  onReady:async()=>{pendingAudio=false;await respond();},
  onError:async message=>{const failedDraft=draft;if(!failedDraft)return;const hasAudio=await input.hasPending(`story:${failedDraft.id}`).catch(()=>false);if(draft!==failedDraft||screen!=='conversation')return;pendingAudio=hasAudio;render();notify(message);say(pendingAudio?'刚才没能记好，已经收到的声音先留着。请老师帮忙检查，再选重新听这段。':message);}
});
function playReply(current) {
  if(!current||aiPending||replyPhase)return;
  clearTimeout(focusTimer);replyError=false;replyPhase='preparing';prompt='';render();
  const reply=current.turns.filter(t=>t.role==='assistant').at(-1)?.text||opening;
  const ended=/(不想说了|不说了|讲完了|说完了|今天就到这里)[。！!\s]*$/.test(words().at(-1)||'');
  const ending=current.roundComplete?'':ended?'要记下来，用方向键选小本子，按回车。':'想继续说，再按空格。讲好了，就选小本子。';
  guide=reply+ending;
  let shown='';
  speaker.speak(guide,()=>{
    if(draft!==current||screen!=='conversation')return;
    replyPhase='';prompt=reply;render();
    if(current.roundComplete)finishStory();else $('#record-toggle')?.focus();
  },{
    onPreparing:()=>{if(draft===current&&screen==='conversation'){replyPhase='preparing';render();}},
    onChunk:text=>{
      if(draft!==current||screen!=='conversation')return;
      shown+=text;prompt=shown;replyPhase='playing';render();
    },
    onError:()=>{
      if(draft!==current||screen!=='conversation')return;
      replyPhase='';replyError=true;render();$('#retry-reply')?.focus();
    }
  });
}
async function respond(){
  if(aiPending||!draft||capture!=='idle')return;
  clearTimeout(focusTimer);replyError=false;aiPending=true;silence();render();const current=draft;
  const wait=setTimeout(()=>say('我还在想你刚才说的话，稍等一下。'),6000);
  try{
    const result=await api('chat',{turns:current.turns,childName:child.name,conversationRounds:current.conversationRounds??configuredRounds});
    const reply=result.text||result.reply;if(!reply)throw new Error('鸭鸭没有返回内容');
    const next=structuredClone(current);next.turns.push({role:'assistant',text:reply});next.aiError=false;next.roundComplete=Boolean(result.isFinalRound);
    await update(state=>{state.drafts[next.child.id]=next;});
    draft=next;drafts[next.child.id]=next;clearTimeout(wait);aiPending=false;playReply(next);
  }catch(e){
    clearTimeout(wait);aiPending=false;render();notify(e.message);
    say('你的话已经留好了，鸭鸭暂时没能接上。可以请老师帮忙，再选请鸭鸭接着说，也可以选小本子结束。');
  }
}
function toggleCapture(){
  if(screen!=='conversation'||interactionLocked())return;
  if(replyError){playReply(draft);return;}
  if(roundLimitReached()){say(draft.aiError?'先请鸭鸭接着说，再一起记故事。':'这次讲好啦。选小本子，按回车，我们一起核对故事。');return;}
  if(capture==='cue'){silence();capture='idle';render();return;}
  if(capture==='starting')return;
  if(capture==='listening'){input.stop();return;}
  if(pendingAudio){say('还有一段没听清的声音，请先选重新听这段。');return;}
  capture='cue';render();say('听到小提示音后就可以说啦，说完再按空格。',()=>{if(capture!=='cue')return;input.start(audioKey());});
}
async function finishStory(){
  if(pendingAudio){say('还有一段声音没有记好，先重新听这段，或者重新说这一段。');return;}
  if(interactionLocked()||capture!=='idle')return;
  if(replyError){playReply(draft);return;}
  if(draft.editedText!==undefined){go('review');return;}
  aiPending=true;render();say('今天讲好了，我来整理你的小故事。');
  try{const result=await api('summary',{turns:draft.turns});draft.editedText=result.text;}
  catch(e){draft.editedText=words().join('\n\n');notify('整理暂时没完成，先保留你的原话，请老师一起核对。');}
  finally{aiPending=false;}
  try{await syncDraft();go('review');}catch{render();}
}
async function save(){
  if(pendingAudio){go('conversation');say('还有一段声音没有记好，请先处理这段录音。');return;}
  if(saving)return;const text=draft.editedText.trim();if(!text){say('这里还没有故事，请老师帮忙核对一下。');$('#record-text').focus();return;}
  saving=true;$('#main').inert=true;$('#save-button').disabled=true;
  const record={id:draft.id,child:{...draft.child},activityDate:draft.activityDate,createdAt:draft.createdAt,text,turns:structuredClone(draft.turns)};
  try{await syncDraft();await update(next=>{next.records=[record,...next.records.filter(r=>r.id!==record.id)];delete next.drafts[child.id];});records=[record,...records.filter(r=>r.id!==record.id)];delete drafts[child.id];draft=null;saving=false;go('saved');}
  catch(e){saving=false;render();notify(e.message);say('还没有保存成功，故事还在这里。请老师帮忙检查，再选记下今天。');}
  finally{$('#main').inert=false;if(screen==='saved')$('#next-child')?.focus({preventScroll:true});}
}
document.addEventListener('keydown',event=>{
  if(interactionLocked()&&['Space','Enter','Escape','Tab','F1','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.code)){event.preventDefault();event.stopImmediatePropagation();}
},true);
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
// Arrow navigation stays inside the child's current activity. Native Tab also works.
document.addEventListener('keydown', event => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'F1') { event.preventDefault(); if (capture === 'idle') {if(replyError||(screen==='conversation'&&words().length&&!draft.aiError))playReply(draft);else say(guide||stepGuide());} return; }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (screen === 'roster') { silence(); return; }
    if(saving||aiPending||capture==='stopping')return;
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
window.addEventListener('pagehide', () => { if(replyPhase){replyPhase='';replyError=true;} silence(); input.cancel(); });
window.addEventListener('pageshow',event=>{if(event.persisted&&replyError){render();$('#retry-reply')?.focus();}});
render(); document.querySelector('[data-child]')?.focus({preventScroll:true}); guide = stepGuide(); say(guide);

window.addEventListener('beforeunload',e=>{if(capture!=='idle'||aiPending||saving||draftWrites||draftUnsaved){e.preventDefault();e.returnValue='';}});
