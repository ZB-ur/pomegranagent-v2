import {api} from './store.mjs';
import {Recorder, Speaker} from './audio.mjs';
const $=selector=>document.querySelector(selector);
const message=text=>{$('#message').textContent=text;};
let settings, recording=false, busy=false, playback='idle', pending=false, restoring=false, fileEpoch=0;
const configStatus=value=>value.chatConfigured?'对话参数已保存；真实效果请通过上面的虚构听说检查确认。':'尚未配置对话服务，本机听说可以先检查。';
function controls(){
  $('#mic').disabled=busy||restoring;$('#listen').disabled=busy||recording||restoring;
  $('#voice-choice').disabled=busy||recording||restoring;$('#save-voice').disabled=busy||recording||restoring;
  $('#restore-file').disabled=restoring||busy||recording;$('#restore').disabled=restoring||busy||recording;
  $('#rerecord-device').hidden=!pending;$('#rerecord-device').disabled=busy||recording||restoring;
  $('#retry-recording').hidden=!pending;$('#retry-recording').disabled=busy||recording||restoring;
}
function showStatus(value){
  const local=value.localVoice;
  $('#local-badge').textContent=local?.ready?'本机模型已安装':'还需准备';
  $('#local-badge').classList.toggle('done',Boolean(local?.ready));
  $('#local-status').textContent=local?.message||'还没有检查到本机语音，请先运行语音准备脚本。';
  $('#config-status').textContent=configStatus(value);
}
async function loadSettings(){
  settings=await api('settings',undefined,'GET');showStatus(settings);$('#conversation-rounds').value=settings.conversationRounds??3;
  for(const input of document.querySelectorAll('#settings-form input'))if(input.name!=='apiKey')input.value=settings[input.name]||'';
  const voices=settings.localVoice?.voices||[];
  const names={'zf_001':'中文女声一','zf_002':'中文女声二','zf_003':'中文女声三','zf_004':'中文女声四','zm_009':'中文男声'};
  $('#voice-choice').replaceChildren(new Option('默认中文女声',''),...voices.map(voice=>new Option(names[voice]||voice,voice)));
  $('#voice-choice').value=voices.includes(settings.voice)?settings.voice:'';
}
try{await loadSettings();const health=await api('health',undefined,'GET');$('#environment').textContent=[health.platform,health.release,health.architecture,'Python '+health.python].join(' / ');}catch(e){message(e.message);}
$('#refresh-status').onclick=async()=>{try{showStatus(await api('settings',undefined,'GET'));}catch(e){message(e.message);}};
$('#settings-form').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
  try{const saved=await api('settings',Object.fromEntries(new FormData(event.target)),'PUT');event.target.elements.apiKey.value='';showStatus(saved);message('对话设置已保存。');}catch(e){message(e.message);}finally{button.disabled=false;}
};
$('#save-voice').onclick=async()=>{
  if(recording||busy||restoring)return;speaker.stop();
  try{await api('settings',{voice:$('#voice-choice').value},'PUT');speaker.clearCache();message('声音已保存，点“听中文引导”试听。');}catch(e){message(e.message);}
};
const speaker=new Speaker(value=>{
  if(value){playback='playing';$('#device-status').textContent='鸭鸭正在说话，请亲耳确认是否听清。';}
  else if(playback==='playing'){playback='idle';$('#device-status').textContent='播放已结束；请亲耳判断声音是否清楚自然。';}
},error=>{playback='idle';$('#device-error').textContent=error;$('#device-status').textContent='声音还没有准备好，请按提示检查后重听。';});
let recognized='';
const recorder=new Recorder({
  onState:state=>{recording=state==='listening';busy=['starting','stopping'].includes(state);controls();$('#mic').textContent=recording?'停止录音并识别':'② 开始录音';$('#device-status').textContent=recording?'正在录音；停顿不会提交，说完点击停止。':state==='starting'?'正在打开麦克风，请允许这台浏览器录音。':state==='stopping'?'已经停止收音，正在本机识别。':'录音已处理。';},
  onCommit:async text=>{recognized=text;$('#device-result').hidden=false;$('#device-result').textContent='你刚才说：'+text;},
  onReady:async()=>{pending=false;busy=true;controls();$('#device-status').textContent='识别已完成，正在等待 DeepSeek 接话。';try{const result=await api('chat',{turns:[{role:'child',text:recognized}]});$('#device-result').textContent+='\n\n鸭鸭回应：'+result.text;playback='preparing';$('#device-status').textContent='正在本机准备鸭鸭的回应。';speaker.speak(result.text);}catch(e){$('#device-error').textContent=e.message;$('#device-status').textContent='本机识别已完成；对话服务还没接上。';}finally{busy=false;controls();}},
  onError:async error=>{$('#device-status').textContent='这段听说检查尚未完成，可以检查后重试。';busy=false;pending=await recorder.hasPending('device-check').catch(()=>false);controls();$('#device-error').textContent=error;}
});
$('#listen').onclick=()=>{if(recording||busy||restoring)return;$('#device-error').textContent='';playback='preparing';$('#device-status').textContent='正在准备中文引导，首次加载请稍等。';speaker.speak('你好呀，我是鸭鸭。按一下空格开始说，说完以后，再按一下。');};
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
  try{await api('restore',backup);$('#restore-preview').textContent='恢复成功。回到教师工作台即可查看资料。';$('#restore').hidden=true;backup=null;message('');}
  catch(e){message(e.message);}finally{restoring=false;controls();}
};
window.addEventListener('beforeunload',event=>{if(recording||busy||restoring){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{recorder.cancel();speaker.stop();});

$('#rounds-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{const saved=await api('settings',{conversationRounds:Number($('#conversation-rounds').value)},'PUT');$('#conversation-rounds').value=saved.conversationRounds;$('#rounds-status').textContent=`已保存：每次 ${saved.conversationRounds} 轮，对新开始的对话生效。`;}catch(error){$('#rounds-status').textContent=error.message;}finally{button.disabled=false;}};
