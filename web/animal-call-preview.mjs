import { Speaker } from './audio.mjs';
import { DIARY_THEMES } from './diary-themes.mjs';
import { chooseDuckCall } from './duck-voice.mjs';
const status=document.querySelector('#status');
const speaker=new Speaker(()=>{},error=>{status.textContent=error;});
let audio;
function stop(){speaker.stop();if(audio){audio.pause();audio=null;}}
document.querySelector('#samples').innerHTML=DIARY_THEMES.map(t=>`<section class="card"><h2>${t.hostName}</h2><blockquote>谢谢你把今天的小发现讲给我听。</blockquote><div class="sample-actions"><button data-theme="${t.id}" data-mode="alone">只听音效</button> <button data-theme="${t.id}" data-mode="prefix">放在句首</button> <button data-theme="${t.id}" data-mode="suffix">放在句尾</button> <button data-theme="${t.id}" data-mode="random">随机试一次 · 35%</button></div></section>`).join('');
document.querySelector('#samples').onclick=async event=>{
 const button=event.target.closest('[data-mode]');if(!button)return;stop();
 const theme=DIARY_THEMES.find(t=>t.id===button.dataset.theme);const mode=button.dataset.mode;
 speaker.themeId=theme.id;
 if(mode==='alone'){
  audio=new Audio(theme.callDirectory+'/prefix.wav');const current=audio;
  status.textContent=`正在播放${theme.hostName}的短音效…`;
  current.onended=()=>{if(audio===current)status.textContent='播放完毕，可以换一段比较。';};
  try{await current.play();}catch(error){if(audio===current)status.textContent='声音没有播放成功，请再试一次。';}return;
 }
 const cue=mode==='random'?chooseDuckCall():mode;
 status.textContent=`${theme.hostName}：${cue==='prefix'?'句首音效':cue==='suffix'?'句尾音效':'这次只播正文'}，正在准备声音…`;
 await speaker.speak('谢谢你把今天的小发现讲给我听。',()=>{status.textContent='播放完毕，可以换一段比较。';},{duckCall:cue});
};
document.querySelector('#stop').onclick=()=>{stop();status.textContent='已停止。';};
window.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('#stop').click();});
window.addEventListener('pagehide',()=>{stop();speaker.clearCache();});
