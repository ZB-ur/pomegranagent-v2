import { Recorder, Speaker, handlesSpace } from './audio.mjs';
import { duckLine, chooseDuckCall } from './duck-voice.mjs';
import { loadData, rosterFor, dateKey, recordDate, read, update, api, refresh } from './store.mjs';

const $ = selector => document.querySelector(selector);
const DRAFT_KEY = 'penegranagent-v2:prototype:child-drafts';
const RECORDS_KEY = 'penegranagent-v2:prototype:records';
const activityDate = dateKey();
const opening = duckLine('今天，你和小鸭一起做了什么呀？');
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
let closingTimer, closingSeconds=3, closingStage='', closingError='', finishAfterInput=false;
const closingCue='你的故事讲好啦，我帮你记下来。';
const replyCalls = new Map();
const continueCue=duckLine('想继续说，按空格。');
let operationController, operationEpoch=0, leaving=false, waitTimer, waitActive=false, exitAvailable=false;
const interactionLocked = () => leaving || saving || ['conversation','closing'].includes(screen) && (aiPending || saving || capture==='stopping' || Boolean(replyPhase));
let liveText = draft?.pendingText ?? '';
let prompt = draft?.turns.filter(turn => turn.role === 'assistant').at(-1)?.text ?? opening;
let guide = '';
let guideIsVerbatim = false;
let speaking = false, voiceError='';
let voiceVisualActive=false, voiceVisualTimer;

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
    child=person;draft=existing;pendingAudio=hasAudio;replyError=false;finishAfterInput=false;
    if(draft)draft.conversationRounds??=configuredRounds;
    if(!draft){await start();return;}
    liveText=draft.pendingText??'';
    prompt=draft.turns.filter(turn=>turn.role==='assistant').at(-1)?.text??opening;
    go('conversation');
    if(draft.autoFinish&&!pendingAudio){beginClosing();}
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

// Recovery controls remain outside the locked child activity.
function updateWaitExit(){
  const waiting=!leaving&&['conversation','closing'].includes(screen)&&(aiPending||capture==='stopping'||capture==='starting'||capture==='cue'||(screen==='closing'&&closingStage==='cue')||replyPhase==='preparing');
  if(waiting&&!waitActive){waitActive=true;waitTimer=setTimeout(()=>{exitAvailable=true;showExit();},15000);}
  if(!waiting){clearTimeout(waitTimer);waitActive=false;exitAvailable=false;$('#safe-exit')?.remove();if(!$('#exit-dialog'))recoveryVoice.stop();}
}
function showExit(){
  if(!waitActive||$('#safe-exit'))return;
  const button=document.createElement('button');button.id='safe-exit';button.className='quiet-button';button.textContent='等待较久 · 请老师安全退出';
  button.onclick=()=>{
    if($('#exit-dialog'))return;
    const dialog=document.createElement('dialog');dialog.id='exit-dialog';dialog.setAttribute('aria-labelledby','exit-title');
    dialog.innerHTML='<h2 id="exit-title">先休息，保留这次故事？</h2><p>退出会停止等待，保留已保存的文字和本浏览器暂存录音，不会标记为已完成。下次选自己的头像继续。</p><button id="stay-waiting">继续等待</button><button id="confirm-exit">保留草稿并退出</button><p id="exit-error" role="alert"></p>';
    document.body.append(dialog);dialog.showModal();$('#stay-waiting').focus();
    const dismiss=()=>{recoveryVoice.stop();dialog.close();dialog.remove();};
    const exitGuide='可以继续等，也可以请老师保留草稿，先退出。退出不会记为完成。';
    recoveryVoice.speak(exitGuide);
    dialog.addEventListener('keydown',e=>{if(e.key==='F1'){e.preventDefault();recoveryVoice.speak(exitGuide);}});
    dialog.querySelectorAll('button').forEach(b=>b.onfocus=()=>recoveryVoice.speak(b.textContent+'。按回车选择。'));
    dialog.addEventListener('cancel',e=>{if(leaving)e.preventDefault();else dismiss();});$('#stay-waiting').onclick=dismiss;
    $('#confirm-exit').onclick=async()=>{
      if(leaving)return;leaving=true;++operationEpoch;operationController?.abort();clearTimeout(focusTimer);silence();recoveryVoice.stop();dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{
        await input.cancel();await draftSave.catch(()=>{});if(draftUnsaved)await syncDraft();await refresh();
        records=read(RECORDS_KEY,[]);drafts=read(DRAFT_KEY,{});
        capture='idle';aiPending=false;replyPhase='';replyError=false;pendingAudio=false;
        child=null;draft=null;liveText='';leaving=false;dismiss();go('roster');
      }catch(e){leaving=false;capture='idle';aiPending=false;replyPhase='';replyError=false;render();$('#exit-error').textContent='还没能确认资料状态，先不要关闭页面。'+e.message;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
    };
  };
  document.body.append(button);button.onfocus=()=>recoveryVoice.speak('等得有点久了。请老师帮忙，按回车选择安全退出。');recoveryVoice.speak('等得有点久了，可以请老师帮忙，按 Tab 选择安全退出。');
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
  return voiceVisualActive ? 'speaking' : interactionLocked() ? 'thinking' : capture === 'listening' ? 'listening' : ['saved','closing'].includes(screen) ? 'happy' : 'idle';
}
function refreshMood() {
  document.querySelectorAll('.mascot').forEach(el => {
    const next=mood();
    if(el.dataset.mood!==next)console.debug('[duck] pose '+el.dataset.mood+' -> '+next);
    el.dataset.mood=next;el.dataset.voicePaused=String(voiceVisualActive&&!speaking);
  });
  $('#voice-status').textContent = voiceError || (replyPhase==='preparing'?'正在准备鸭鸭的声音':speaking ? '鸭鸭正在说话' : soundUnlocked ? '语音引导已开启' : '点小鸭，听语音引导');
}
class GuideSpeaker extends Speaker {
  speak(text,onDone,playback) { return super.speak(duckLine(text),onDone,playback); }
}
const recoveryVoice = new GuideSpeaker(()=>{},message=>notify(message));
const speaker = new Speaker((value,detail)=>{
  speaking=value;clearTimeout(voiceVisualTimer);
  if(value){voiceVisualActive=true;soundUnlocked=true;voiceError='';}
  else if(detail?.phase!=='buffering'){
    // Keep the same drawing across short sentence/closing-cue boundaries.
    voiceVisualTimer=setTimeout(()=>{voiceVisualActive=false;refreshMood();},180);
  }
  refreshMood();
},message=>{voiceError='声音未就绪 · 请老师帮忙';notify(message);$('#voice-status').textContent=voiceError;if(capture==='cue'){capture='idle';render();}});
function silence(){speaker.stop();}
function say(text,onDone,verbatim=false){guide=verbatim?text:duckLine(text);guideIsVerbatim=verbatim;if(capture==='listening')return;speaker.speak(guide,onDone);}
function stepGuide() {
  if (screen === 'roster' && !currentRoster().length) return '还没有安排小朋友，请老师先帮忙安排一下吧。';
  if (screen === 'roster') return '今天轮到你们照顾小鸭啦。找到自己的头像，用方向键选一选，按回车就可以和我说话。';
  if(screen==='conversation'&&pendingAudio)return '你上次说的声音还在。请老师检查服务后，用方向键选重新听这段，再按回车。';
  if(screen==='conversation'&&roundLimitReached())return draft.aiError?'你的话已经留好了。选请鸭鸭再接着说，听完我们就记故事。':`${prompt} 选小本子，我帮你记下来。`;
  if (screen === 'conversation') return `${child.name}，你好呀。${prompt} 按一下空格键，开始说话。说完以后，再按一下。今天讲好了，用方向键选小本子，再按回车。`;
  if (screen === 'closing') return closingError?'还没有记好，请老师帮忙，再试一次。':closingCue;
  if (screen === 'saved') return `${child.name}，记好啦！按回车，回到大家的头像，让下一位小朋友来讲吧。`;
  return '这里都是记下来的故事。点每段故事的小喇叭，就可以听。';
}
function go(next, announce = true) {
  clearTimeout(focusTimer); clearInterval(closingTimer); silence(); screen = next; render();
  const first = screen === 'roster' ? document.querySelectorAll('[data-child]')[rosterFocus] : screen === 'conversation' ? (roundLimitReached()?($('#retry-ai')??$('#finish-button')):$('#record-toggle')) : screen === 'closing' ? $('#finish-now') : screen === 'saved' ? $('#next-child') : $('#return-button');
  (first ?? $('#main')).focus({ preventScroll:true });
  guide = stepGuide(); guideIsVerbatim=false; if (announce) say(guide);
}
async function start() {
  if (!child) { go('roster'); return; }
  draft = { id:crypto.randomUUID(), child:{...child}, activityDate, conversationRounds:configuredRounds, createdAt:new Date().toISOString(), turns:[{role:'assistant',text:opening}], pendingText:'' };
  liveText = ''; prompt = opening;try{await syncDraft();go('conversation');}catch{child=null;draft=null;render();say('还没准备好保存故事，请老师检查本机服务。');}
}
function transcript(turns) { return turns.map(turn => `<div class="transcript-line"><span>${turn.role === 'child' ? '孩子' : '鸭鸭'}</span><p>${escape(turn.text)}</p></div>`).join(''); }
function render() {
  updateWaitExit();
  const focusedId = document.activeElement?.id;
  $('#record-count').textContent = child ? records.filter(record=>record.child?.id===child.id).length : '—';
  $('#history-button').disabled = screen==='closing' || capture !== 'idle' || aiPending || saving || !child;
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
    $('#main').innerHTML = `<section class="child-scene"><div class="friend-column"><p class="eyebrow">${listening ? '我在认真听' : '鸭鸭一直陪着你'}</p>${mascot(mood())}<span class="friend-caption">${listening ? '想一想也没关系' : waiting ? (speaking?'先听我说完，再轮到你':'我会陪你一起等') : '点点我，听我再说一遍'}</span></div><div class="talk-column"><div class="identity-strip">${avatar(child,'mini')}<strong>${escape(child.name)}正在讲故事</strong><button id="switch-child" class="text-button">换个人 · Esc</button></div><div role="status" class="status-pill ${waiting&&replyPhase!=='playing'?'waiting':listening ? 'live' : ''}"><span></span>${replyPhase==='playing' ? (draft.endRequested||draft.roundComplete||finishAfterInput?'听鸭鸭说完，我帮你记下来':'听鸭鸭说完，就轮到你') : replyPhase ? '正在准备鸭鸭的声音' : capture === 'starting' ? '正在打开麦克风' : capture === 'cue' ? '听完这句话，就轮到你' : listening ? '轮到你说啦' : waiting ? '把这句话记下来' : roundLimitReached() ? '今天讲好啦' : '我们接着聊'}</div><h1 class="conversation-prompt">${escape(replyPhase==='preparing'&&!prompt?'鸭鸭想好了，马上说给你听。':prompt)}</h1><div class="heard"><span>${listening ? '正在收音，停下来后再核对' : liveText ? '刚才还没说完的' : '你刚才说'}</span><p id="live-text">${escape(liveText || words().at(-1) || '说一点点，也可以。')}</p></div><button id="record-toggle" class="primary ${listening ? 'recording' : ''}" ${waiting || roundLimitReached() ? 'disabled' : ''}>${icon(listening ? 'stop' : 'mic')}<span>${listening ? '说好了，按一下' : capture === 'cue' ? '准备好，再开口' : waiting ? '等我一下' : roundLimitReached() ? '这次讲好啦' : '我来说一说'}</span></button><div class="keyboard-cue"><kbd>${roundLimitReached()?'回车':'空格'}</kbd><span>${waiting?'先听鸭鸭说，键盘休息一下':roundLimitReached()?'选小本子，核对故事':listening ? '再按一下，停止说话' : '按一下，开始说话'}</span></div><button id="finish-button" class="finish-button" ${(capture !== 'idle'&&capture!=='listening') || aiPending || pendingAudio || (!words().length&&capture!=='listening') ? 'disabled' : ''}>${icon('book')}<span>今天讲好啦</span><span>→</span></button>${pendingAudio&&capture==='idle'&&!aiPending?'<button id="retry-audio" class="quiet-button">重新听这段录音</button><button id="rerecord" class="quiet-button">重新说这一段</button>':''}${replyError?'<button id="retry-reply" class="quiet-button">重新听鸭鸭的回复</button>':''}${draft.aiError&&!aiPending&&capture==='idle'?'<button id="retry-ai" class="quiet-button">请鸭鸭再接着说</button>':''}</div></section>`;
    $('#record-toggle').onclick = toggleCapture;
    if($('#retry-reply'))$('#retry-reply').onclick=()=>playReply(draft);
    if(replyError){const help=document.createElement('button');help.className='quiet-button';help.textContent='请老师帮忙保存';help.onclick=()=>{replyError=false;silence();beginClosing(false);};$('.talk-column').append(help);}
    if($('#retry-audio'))$('#retry-audio').onclick=()=>{silence();input.retry(audioKey());};
    if($('#rerecord'))$('#rerecord').onclick=async()=>{try{if(!await input.setAside(audioKey()))return;pendingAudio=false;render();say('上一段声音先放好，按空格，重新讲这一段吧。');}catch(e){notify(e.message);}};
    if($('#retry-ai'))$('#retry-ai').onclick=()=>respond();
    $('#switch-child').onclick = returnToRoster;
    $('#finish-button').onclick = finishStory;
  } else if (screen === 'closing') {
    const counting=closingStage==='countdown';
    $('#main').innerHTML=`<section class="child-scene"><div class="friend-column">${mascot(mood())}</div><div class="talk-column"><p class="chapter">${escape(child.name)}的小故事</p><h1>${closingError?'还没有记好，故事还在。':saving?'正在记进小本子。':aiPending?'我来整理你的小故事。':'今天讲好啦！'}</h1><p class="support">${closingError?escape(closingError):counting?'我会帮你记下来。':'鸭鸭陪着你。'}</p><button id="finish-now" class="primary finish-countdown ${counting?'counting':''}" ${closingStage==='cue'||aiPending||saving?'disabled':''}>${icon('book')}<span>${closingError?'请老师帮忙，再试一次':'今天讲好啦'}</span>${counting?`<span class="countdown-number" aria-hidden="true">${closingSeconds}</span>`:''}</button>${counting&&!roundLimitReached()?'<p class="keyboard-cue"><kbd>空格</kbd>还想说，可以继续</p>':''}${closingError?'<button id="leave-draft" class="quiet-button">先保留草稿，换个人</button>':''}</div></section>`;
    $('#finish-now').onclick=()=>completeStory();
    if($('#leave-draft'))$('#leave-draft').onclick=returnToRoster;
  } else if (screen === 'saved') {
    $('#main').innerHTML = `<section class="child-scene"><div class="friend-column">${mascot('happy')}</div><div class="talk-column"><p class="chapter">又多了一个温暖的小故事</p><h1>记好啦，<br>下次再聊！</h1><p class="support">我会在这里，等你的新故事。</p><button class="primary" id="next-child">下一位小朋友<span>→</span></button></div></section>`;
    $('#next-child').onclick = returnToRoster;
  } else {
    $('#main').innerHTML = `<section class="history-layout"><aside>${mascot('idle',true)}<h1>我们的小故事</h1><button class="quiet-button" id="return-button">${draft ? '回去继续聊 →' : '回到今日头像 →'}</button></aside><div class="record-list">${records.filter(r=>r.child?.id===child?.id).length ? records.filter(r=>r.child?.id===child?.id).map(record => `<article class="paper history-paper"><div class="paper-heading"><span>${escape(record.child?.name ?? '旧版示例')}的鸭鸭日记</span><time>${dateLabel(record.createdAt)}</time></div><div class="paper-title"><h2>我和小鸭的一天</h2><button class="read-button" data-record="${escape(record.id)}" aria-label="听这篇故事">${icon('sound')}</button></div><p class="record-body">${escape(record.text)}</p><details><summary>对话原文</summary>${transcript(record.turns)}</details></article>`).join('') : '<div class="empty-state"><h2>第一段故事，还在等你。</h2><p>和鸭鸭聊一聊，就会有自己的故事啦。</p></div>'}</div></section>`;
    $('#return-button').onclick = () => draft ? go('conversation') : returnToRoster();
    document.querySelectorAll('[data-record]').forEach(button => { button.onclick = () => say(records.find(record => record.id === button.dataset.record).text,undefined,true); });
  }
  document.querySelectorAll('.mascot').forEach(button => { button.onclick = () => {
    if(interactionLocked())return;
    if(replyError){playReply(draft);return;}
    if(screen==='closing'){if(['cue','countdown'].includes(closingStage))beginClosing();else say(stepGuide());return;}
    if (capture !== 'idle') { notify('正在听你说话，再按空格停止后，鸭鸭就能开口啦。'); return; }
    say(guide || stepGuide(),undefined,guideIsVerbatim);
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
    if(leaving)return;const owner=draft;
    if(draft.turns.some(turn=>turn.inputId===inputId))return;
    const next=structuredClone(draft);delete next.autoFinish;delete next.endRequested;next.turns.push({role:'child',text,inputId});next.pendingText='';next.aiError=true;delete next.editedText;
    await update(state=>{state.drafts[child.id]=next;});if(leaving||draft!==owner)return;draft=next;drafts[child.id]=next;liveText='';
  },
  onReady:async()=>{if(leaving)return;pendingAudio=false;await respond();},
  onError:async message=>{const failedDraft=draft;if(!failedDraft)return;const hasAudio=await input.hasPending(`story:${failedDraft.id}`).catch(()=>false);if(draft!==failedDraft||screen!=='conversation')return;pendingAudio=hasAudio;render();notify(message);say(pendingAudio?'刚才没能记好，已经收到的声音先留着。请老师帮忙检查，再选重新听这段。':message);}
});
function playReply(current) {
  if(!current||aiPending||replyPhase)return;
  clearTimeout(focusTimer);replyError=false;replyPhase='preparing';prompt='';render();
  const reply=duckLine(current.turns.filter(t=>t.role==='assistant').at(-1)?.text||opening);
  const callKey=current.id+':'+current.turns.length;
  if(!replyCalls.has(callKey))replyCalls.set(callKey,chooseDuckCall());
  const ended=current.roundComplete||current.endRequested||finishAfterInput;
  guide=reply+(ended?'':continueCue);guideIsVerbatim=false;
  let shown='';
  const refreshReply=()=>{
    // Updating a sentence must not recreate the mascot or restart its animation.
    $('.conversation-prompt').textContent=prompt||'鸭鸭想好了，马上说给你听。';
    const waiting=replyPhase==='preparing',pill=$('.status-pill');
    pill.classList.toggle('waiting',waiting);
    pill.replaceChildren(document.createElement('span'),document.createTextNode(waiting?'正在准备鸭鸭的声音':ended?'听鸭鸭说完，我帮你记下来':'听鸭鸭说完，就轮到你'));
    $('.friend-caption').textContent=waiting?'我会陪你一起等':'先听我说完，再轮到你';
    refreshMood();updateWaitExit();
  };
  speaker.speak(guide,()=>{
    if(draft!==current||screen!=='conversation')return;
    replyPhase='';prompt=reply;render();
    if(ended)beginClosing();else $('#record-toggle')?.focus();
  },{
    duckCall:replyCalls.get(callKey), duckCallText:reply,
    onCue:()=>{
      if(draft!==current||screen!=='conversation')return;
      replyPhase='playing';refreshReply();
      if(!shown)$('.conversation-prompt').textContent='鸭鸭轻轻叫了一声';
    },
    onPreparing:()=>{if(draft===current&&screen==='conversation'){replyPhase='preparing';refreshReply();}},
    onChunk:text=>{
      if(draft!==current||screen!=='conversation')return;
      shown+=text;prompt=shown;replyPhase='playing';refreshReply();
    },
    onError:()=>{
      if(draft!==current||screen!=='conversation')return;
      replyPhase='';replyError=true;render();$('#retry-reply')?.focus();
    }
  });
}
async function respond(){
  if(aiPending||!draft||capture!=='idle')return;
  clearTimeout(focusTimer);replyError=false;aiPending=true;silence();render();const current=draft,epoch=operationEpoch;operationController=new AbortController();
  const wait=setTimeout(()=>{if(epoch===operationEpoch&&!leaving)say('我还在想你刚才说的话，稍等一下。');},6000);
  try{
    const result=await api('chat',{turns:current.turns,childName:child.name,conversationRounds:current.conversationRounds??configuredRounds},'POST',operationController.signal);
    if(epoch!==operationEpoch||leaving)return;
    const reply=result.text||result.reply;if(!reply)throw new Error('鸭鸭没有返回内容');
    const next=structuredClone(current);next.turns.push({role:'assistant',text:reply});next.aiError=false;next.roundComplete=Boolean(result.isFinalRound);next.endRequested=Boolean(result.endConversation);next.autoFinish=next.roundComplete||next.endRequested||finishAfterInput;
    await update(state=>{state.drafts[next.child.id]=next;});
    if(epoch!==operationEpoch||leaving)return;
    draft=next;drafts[next.child.id]=next;clearTimeout(wait);aiPending=false;playReply(next);
  }catch(e){
    clearTimeout(wait);if(epoch!==operationEpoch||leaving)return;aiPending=false;render();notify(e.message);
    say('你的话已经留好了，鸭鸭暂时没能接上。可以请老师帮忙，再选请鸭鸭接着说，也可以选小本子结束。');
  }
}
function toggleCapture(){
  if(screen==='closing'){if(closingStage==='countdown'&&!roundLimitReached())resumeSpeaking();return;}
  if(screen!=='conversation'||interactionLocked())return;
  if(replyError){playReply(draft);return;}
  if(roundLimitReached()){say(draft.aiError?'先请鸭鸭接着说，再一起记故事。':'这次讲好啦。选小本子，按回车，我帮你记下来。');return;}
  if(capture==='cue'){silence();capture='idle';render();return;}
  if(capture==='starting')return;
  if(capture==='listening'){input.stop();return;}
  if(pendingAudio){say('还有一段没听清的声音，请先选重新听这段。');return;}
  capture='cue';render();say('听到小提示音后就可以说啦，说完再按空格。',()=>{if(capture!=='cue')return;input.start(audioKey());});
}
function finishStory(){
  if(capture==='listening'){finishAfterInput=true;input.stop();return;}
  if(pendingAudio){say('还有一段声音没有记好，先重新听这段，或者重新说这一段。');return;}
  if(interactionLocked()||capture!=='idle'||!words().length)return;
  beginClosing();
}
function beginClosing(withVoice=true){
  if(!draft||saving||aiPending||pendingAudio)return;
  finishAfterInput=false;draft.autoFinish=true;closingError='';closingStage='cue';closingSeconds=3;
  go('closing',false);guide=closingCue;syncDraft().catch(()=>{});
  const owner=draft;
  const count=()=>{
    if(draft!==owner||screen!=='closing'||leaving)return;
    closingStage='countdown';render();$('#finish-now')?.focus();
    closingTimer=setInterval(()=>{
      if(document.hidden||document.querySelector('dialog[open]'))return;
      if(--closingSeconds<=0){clearInterval(closingTimer);completeStory();}
      else {const el=$('.countdown-number');if(el)el.textContent=closingSeconds;}
    },1000);
  };
  if(withVoice)speaker.speak(closingCue+(!roundLimitReached()?duckLine('还想说，按空格。'):''),count,{onError:()=>{if(draft!==owner||screen!=='closing')return;closingStage='error';closingError='声音没有准备好，请老师帮忙保存。';render();$('#finish-now')?.focus();}});
  else count();
}
async function resumeSpeaking(){
  clearInterval(closingTimer);silence();closingStage='';closingError='';draft.autoFinish=false;draft.endRequested=false;finishAfterInput=false;
  syncDraft().catch(()=>{});go('conversation',false);toggleCapture();
}
async function completeStory(){
  if(!draft||saving||aiPending||pendingAudio||leaving)return;
  clearInterval(closingTimer);silence();closingStage='saving';closingError='';
  const current=draft,epoch=operationEpoch;operationController=new AbortController();
  if(current.editedText===undefined){
    aiPending=true;render();say('我正在把你的故事记下来。');
    try{const result=await api('summary',{turns:current.turns},'POST',operationController.signal);if(epoch!==operationEpoch||leaving)return;if(!result.text?.trim())throw new Error('整理内容为空');current.editedText=result.text;}
    catch(e){if(epoch!==operationEpoch||leaving)return;current.editedText=words().join('\n\n');current.summaryFallback=true;}
    finally{if(epoch===operationEpoch&&!leaving)aiPending=false;}
  }
  if(epoch!==operationEpoch||leaving)return;
  const text=current.editedText.trim();
  if(!text){closingStage='error';closingError='还没有可保存的话，请老师帮忙。';render();return;}
  saving=true;render();
  const record={id:current.id,child:{...current.child},activityDate:current.activityDate,createdAt:current.createdAt,text,turns:structuredClone(current.turns),summaryFallback:Boolean(current.summaryFallback)};
  try{
    await syncDraft();
    await update(next=>{next.records=[record,...next.records.filter(r=>r.id!==record.id)];delete next.drafts[current.child.id];});
    records=[record,...records.filter(r=>r.id!==record.id)];delete drafts[current.child.id];draft=null;saving=false;closingStage='';go('saved');
  }catch(e){saving=false;closingStage='error';closingError='还没保存成功，请先不要关闭。'+e.message;render();say('还没有记好，故事还在。请老师帮忙，再试一次。');$('#finish-now')?.focus();}
}
document.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]')||event.target.closest?.('#safe-exit'))return;
  if(interactionLocked()&&!(exitAvailable&&event.code==='Tab')&&['Space','Enter','Escape','Tab','F1','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.code)){event.preventDefault();event.stopImmediatePropagation();}
},true);
// Prevent a held key from scrolling while still issuing just one toggle.
let spaceHeld = false;
document.addEventListener('keyup', event => { if (event.code === 'Space') spaceHeld = false; });
window.addEventListener('blur', () => { spaceHeld = false; });
document.addEventListener('keydown', event => {
  if (!['conversation','closing'].includes(screen)||document.querySelector('dialog[open]')||event.target.closest?.('#safe-exit')) return;
  if (spaceHeld && event.code === 'Space') { event.preventDefault(); return; }
  if (!handlesSpace(event)) return;
  event.preventDefault(); spaceHeld = true; toggleCapture();
});
$('#history-button').onclick = () => screen === 'history' ? (draft ? go('conversation') : returnToRoster()) : go('history');
// Arrow navigation stays inside the child's current activity. Native Tab also works.
document.addEventListener('keydown', event => {
  if(document.querySelector('dialog[open]')||event.target.closest?.('#safe-exit'))return;
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if(screen==='closing'&&!interactionLocked()){
    if(event.key==='Enter'){event.preventDefault();if(event.repeat)return;if(closingStage==='countdown'||closingStage==='error')completeStory();return;}
    if(event.key==='F1'){event.preventDefault();if(['cue','countdown'].includes(closingStage))beginClosing();else say(stepGuide());return;}
    if(event.key==='Escape'||['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();return;}
  }
  if (event.key === 'F1') { event.preventDefault(); if (capture === 'idle') {if(replyError||(screen==='conversation'&&words().length&&!draft.aiError))playReply(draft);else say(guide||stepGuide(),undefined,guideIsVerbatim);} return; }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (screen === 'roster') { silence(); return; }
    if(saving||aiPending||capture==='stopping')return;
    if (screen === 'history' && draft) go('conversation');
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
window.addEventListener('pagehide', () => { clearInterval(closingTimer); if(replyPhase){replyPhase='';replyError=true;} silence(); recoveryVoice.stop(); input.cancel(); });
window.addEventListener('pageshow',event=>{if(event.persisted&&screen==='closing'&&!saving&&!aiPending&&!leaving){beginClosing();return;}if(event.persisted&&replyError){render();$('#retry-reply')?.focus();}});
render(); document.querySelector('[data-child]')?.focus({preventScroll:true}); guide = stepGuide(); say(guide,()=>speaker.preload([continueCue,closingCue,duckLine('还想说，按空格。')]));

window.addEventListener('beforeunload',e=>{if(screen==='closing'||capture!=='idle'||aiPending||saving||draftWrites||draftUnsaved){e.preventDefault();e.returnValue='';}});
