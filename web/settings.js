import {api} from './store.mjs';
import {Recorder, Speaker} from './audio.mjs';
import {DIARY_THEMES, getDiaryTheme, navigationStyle, applyTeacherTheme} from './diary-themes.mjs';
const $=selector=>document.querySelector(selector);
const message=text=>{$('#message').textContent=text;$('#message').hidden=!text;};
const feedback=(selector,text,error=false)=>{const node=$(selector);node.textContent=text;node.classList.toggle('is-error',error);};
let selectedThemeId='duck', savedThemeId='duck';
let settings, recording=false, busy=false, playback='idle', pending=false, restoring=false, fileEpoch=0;
const configStatus=value=>value.chatConfigured?'对话参数已保存；可用虚构内容做一次听说检查。':'尚未配置对话服务，本机听说可以先检查。';
function controls(){
  for(const input of document.querySelectorAll('[name=diaryTheme]'))input.disabled=busy||recording||restoring;
  $('#save-theme').disabled=busy||recording||restoring||selectedThemeId===savedThemeId;
  $('#preview-theme').disabled=busy||recording||restoring;
  $('#mic').disabled=busy||restoring;$('#listen').disabled=busy||recording||restoring;
  $('#voice-choice').disabled=busy||recording||restoring;$('#speech-rate').disabled=busy||recording||restoring;$('#save-voice').disabled=busy||recording||restoring;
  $('#restore-file').disabled=restoring||busy||recording;$('#restore').disabled=restoring||busy||recording;
  $('#rerecord-device').hidden=!pending;$('#rerecord-device').disabled=busy||recording||restoring;
  $('#retry-recording').hidden=!pending;$('#retry-recording').disabled=busy||recording||restoring;
}

function showTheme(){
  const theme=getDiaryTheme(selectedThemeId);
  for(const input of document.querySelectorAll('[name=diaryTheme]')){
    input.checked=input.value===theme.id;
    input.closest('label').querySelector('.theme-marker').textContent=input.value===savedThemeId?'当前装修':input.checked?'预览中':'';
  }
  $('#theme-preview-title').textContent=theme.name+' · '+theme.hostName+'陪伴';
  $('#theme-preview-description').textContent=theme.description;
  feedback('#theme-status',theme.id===savedThemeId?'已是应用装修':'正在预览，保存后统一应用到教师与儿童页面。');
  controls();
}
for(const theme of DIARY_THEMES){
  const card=document.createElement('label');card.className='theme-card';
  const input=document.createElement('input');input.type='radio';input.name='diaryTheme';input.value=theme.id;input.setAttribute('aria-label',theme.name);
  const marker=document.createElement('span');marker.className='theme-marker';marker.setAttribute('aria-hidden','true');
  const image=document.createElement('img');image.src=theme.navigation;image.style.cssText=navigationStyle(theme);image.alt='';image.width=180;image.height=155;
  const title=document.createElement('strong');title.textContent=theme.name;
  const description=document.createElement('small');description.textContent=theme.animalName+'伙伴';
  card.append(input,marker,image,title,description);$('#theme-options').append(card);
  input.onchange=()=>{selectedThemeId=input.value;showTheme();};
}
$('#save-theme').onclick=async()=>{
  if(recording||busy||restoring)return;busy=true;controls();
  try{settings=await api('settings',{diaryThemeId:selectedThemeId},'PUT');savedThemeId=getDiaryTheme(settings.diaryThemeId).id;applyTeacherTheme(savedThemeId);showTheme();feedback('#theme-status','已保存，全应用使用'+getDiaryTheme(savedThemeId).name+'。进行中的故事继续沿用原装修。');}
  catch(error){feedback('#theme-status',error.message,true);}finally{busy=false;controls();}
};
function playGuide(introduction=false){
  if(recording||busy||restoring)return;
  const theme=getDiaryTheme(selectedThemeId);
  $('#device-error').textContent='';playback='preparing';
  $('#device-status').textContent='正在准备中文引导，首次加载请稍等。';
  feedback('#theme-status',theme.id===savedThemeId?'正在试听'+theme.hostName+'的开场。':'正在试听预览外观；尚未保存。');
  feedback('#voice-status','正在试听已保存的声音与语速。');
  speaker.speak(introduction?`你好呀，我是${theme.hostName}。今天，你和${theme.animalName}一起做了什么？`:`你好呀，我是${theme.hostName}。按一下空格开始说，说完以后，再按一下。`,()=>feedback('#theme-status',selectedThemeId===savedThemeId?'试听已结束，当前外观已保存。':'试听已结束，预览外观尚未保存。'));
}
$('#preview-theme').onclick=()=>playGuide(true);

function showStatus(value){
  const local=value.localVoice;
  $('#local-badge').textContent=local?.ready?'本机模型已安装':'还需准备';
  $('#local-badge').classList.toggle('done',Boolean(local?.ready));
  $('#local-status').textContent=local?.message||'还没有检查到本机语音，请先运行语音准备脚本。';
  $('#config-status').textContent=configStatus(value);
}
async function loadSettings(){
  settings=await api('settings',undefined,'GET');showStatus(settings);selectedThemeId=savedThemeId=getDiaryTheme(settings.diaryThemeId).id;applyTeacherTheme(savedThemeId);showTheme();$('#conversation-rounds').value=settings.conversationRounds??3;
  for(const input of document.querySelectorAll('#settings-form input'))if(input.name!=='apiKey')input.value=settings[input.name]||'';
  const voices=settings.localVoice?.voices||[];
  const names={'zf_001':'中文女声一','zf_002':'中文女声二','zf_003':'中文女声三','zf_004':'中文女声四','zm_009':'中文男声'};
  $('#voice-choice').replaceChildren(new Option('默认中文女声',''),...voices.map(voice=>new Option(names[voice]||voice,voice)));
  $('#voice-choice').value=voices.includes(settings.voice)?settings.voice:'';
  $('#speech-rate').value=String(settings.speechRate??1.05);
}
try{await loadSettings();const health=await api('health',undefined,'GET');$('#environment').textContent=[health.platform,health.release,health.architecture,'Python '+health.python].join(' / ');}catch(e){message(e.message);}
$('#refresh-status').onclick=async()=>{try{showStatus(await api('settings',undefined,'GET'));}catch(e){message(e.message);}};
$('#settings-form').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
  try{const saved=await api('settings',Object.fromEntries(new FormData(event.target)),'PUT');event.target.elements.apiKey.value='';settings=saved;showStatus(saved);feedback('#config-save-status','对话设置已保存。');}catch(e){feedback('#config-save-status',e.message,true);}finally{button.disabled=false;}
};
$('#save-voice').onclick=async()=>{
  if(recording||busy||restoring)return;speaker.stop();busy=true;controls();
  try{const saved=await api('settings',{voice:$('#voice-choice').value,speechRate:Number($('#speech-rate').value)},'PUT');settings=saved;$('#speech-rate').value=String(saved.speechRate);speaker.clearCache();feedback('#voice-status','声音和语速已保存，可以试听了。');}catch(e){feedback('#voice-status',e.message,true);}finally{busy=false;controls();}
};
const speaker=new Speaker(value=>{
  if(value){playback='playing';$('#device-status').textContent=getDiaryTheme(selectedThemeId).hostName+'正在说话，请亲耳确认是否听清。';feedback('#voice-status','正在播放已保存的声音与语速。');}
  else if(playback==='playing'){playback='idle';$('#device-status').textContent='播放已结束；请亲耳判断声音是否清楚自然。';feedback('#voice-status','播放已结束。');}
},error=>{playback='idle';$('#device-error').textContent=error;feedback('#voice-status',error,true);$('#device-status').textContent='声音还没有准备好，请按提示检查后重听。';});
let recognized='';
const recorder=new Recorder({
  onState:state=>{recording=state==='listening';busy=['starting','stopping'].includes(state);controls();$('#mic').textContent=recording?'停止录音并识别':'开始录音检查';$('#device-status').textContent=recording?'正在录音；停顿不会提交，说完点击停止。':state==='starting'?'正在打开麦克风，请允许这台浏览器录音。':state==='stopping'?'已经停止收音，正在本机识别。':'录音已处理。';},
  onCommit:async text=>{recognized=text;$('#device-result').hidden=false;$('#device-result').textContent='你刚才说：'+text;},
  onReady:async()=>{pending=false;busy=true;controls();$('#device-status').textContent='识别已完成，正在等待 DeepSeek 接话。';try{const result=await api('chat',{themeId:selectedThemeId,turns:[{role:'child',text:recognized}]});$('#device-result').textContent+='\n\n'+getDiaryTheme(selectedThemeId).hostName+'回应：'+result.text;playback='preparing';$('#device-status').textContent='正在本机准备'+getDiaryTheme(selectedThemeId).hostName+'的回应。';speaker.speak(result.text);}catch(e){$('#device-error').textContent=e.message;$('#device-status').textContent='本机识别已完成；对话服务还没接上。';}finally{busy=false;controls();}},
  onError:async error=>{$('#device-status').textContent='这段听说检查尚未完成，可以检查后重试。';busy=false;pending=await recorder.hasPending('device-check').catch(()=>false);controls();$('#device-error').textContent=error;}
});
$('#listen').onclick=()=>playGuide();
$('#mic').onclick=()=>{if(busy)return;playback='idle';speaker.stop();$('#device-error').textContent='';if(recording)recorder.stop();else if(pending){$('#device-error').textContent='上一段录音还在，请先重试识别。';}else recorder.start('device-check');};
$('#rerecord-device').onclick=async()=>{if(busy||recording||restoring)return;busy=true;controls();speaker.stop();try{if(await recorder.setAside('device-check')){pending=false;$('#device-error').textContent='';$('#device-status').textContent='上一段已保留。点击开始录音，说一段新的虚构内容。';}}catch(e){$('#device-error').textContent=e.message;}finally{busy=false;controls();}};
$('#retry-recording').onclick=()=>{if(busy||recording||restoring)return;playback='idle';speaker.stop();recorder.retry('device-check');};
pending=await recorder.hasPending('device-check').catch(()=>false);controls();
let backup;
$('#restore-file').onchange=async event=>{
  const epoch=++fileEpoch,file=event.target.files[0];backup=null;$('#restore').hidden=true;$('#restore-preview').textContent='';message('');if(!file)return;
  try{
    if(file.size>64*1024*1024)throw new Error('备份文件过大，请选择本应用导出的完整备份。');
    const parsed=JSON.parse(await file.text());if(epoch!==fileEpoch)return;
    const value=parsed.state;
    if(parsed.format!=='penegranagent-v2-backup'||parsed.version!==1||!Array.isArray(value?.data?.children)||!Array.isArray(value?.data?.ducks)||!Array.isArray(value?.records)||!value?.drafts||typeof value.drafts!=='object')throw new Error('这不是完整的日记备份，未修改资料。');
    backup=parsed;$('#restore-preview').textContent=`已选择 ${file.name}，包含 ${value.data.children.length} 位幼儿、${value.records.length} 篇记录。恢复将替换当前资料；原资料会先另存备份。请先结束其他页面正在进行的编辑和录音。`;$('#restore').hidden=false;
  }catch(e){if(epoch!==fileEpoch)return;backup=null;$('#restore').hidden=true;message(e instanceof SyntaxError?'无法读取这份备份，请选择完整的 JSON 备份。':e.message);}
};
$('#restore').onclick=async()=>{
  if(!backup||recording||busy||restoring)return;restoring=true;controls();speaker.stop();
  try{await api('restore',backup);$('#restore-preview').textContent='恢复成功。回到教师工作台即可查看资料。';$('#restore').hidden=true;backup=null;await loadSettings();message('');}
  catch(e){message(e.message);}finally{restoring=false;controls();}
};
window.addEventListener('beforeunload',event=>{if(recording||busy||restoring){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{recorder.cancel();speaker.stop();});

$('#rounds-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{const saved=await api('settings',{conversationRounds:Number($('#conversation-rounds').value)},'PUT');$('#conversation-rounds').value=saved.conversationRounds;$('#rounds-status').textContent=`已保存：每次 ${saved.conversationRounds} 轮，对新开始的对话生效。`;}catch(error){$('#rounds-status').textContent=error.message;}finally{button.disabled=false;}};

// Keep the section marker in step with scrolling without changing the URL or focus.
const links=[...document.querySelectorAll('.settings-nav nav a')];
const markSection=()=>{
  const sections=[...document.querySelectorAll('.settings-section')];
  let current=sections[0];
  for(const section of sections)if(section.getBoundingClientRect().top<160)current=section;
  for(const link of links)if(link.hash==='#'+current.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');
};
window.addEventListener('scroll',markSection,{passive:true});markSection();
for(const selector of ['#voice-choice','#speech-rate'])$(selector).onchange=()=>feedback('#voice-status','声音设置尚未保存；试听使用已保存的声音。');
$('#conversation-rounds').oninput=()=>feedback('#rounds-status','轮数尚未保存。');
for(const input of document.querySelectorAll('#settings-form input'))input.addEventListener('input',()=>feedback('#config-save-status','对话设置尚未保存。'));
