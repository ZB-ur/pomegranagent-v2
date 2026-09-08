import {STORE_KEY,RECORDS_KEY,DRAFT_KEY,escape as esc,dateKey,asDate,shiftDay,read,loadData,saveData,rosterFor,personAvatar,recordDate} from './store.mjs';
const $ = selector => document.querySelector(selector);
let data = loadData();
const today = dateKey();
let selectedDate = today, month = today.slice(0,7), selectedIds = [], dirty = false;
let view = '', search = '', showArchived = false, recordChild = '', recordFilter = 'all';
let toastTimer, dialogReturnFocus;
const names = {schedule:'排班日历',children:'幼儿管理',ducks:'小鸭管理',records:'故事记录'};
const dateText = value => asDate(value).toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
const records = () => read(RECORDS_KEY,[]);
const activeChildren = () => data.children.filter(c=>c.active);
function notify(message) { $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,4200); }
function persist(next) {
  try { saveData(next); data=next; return true; }
  catch { notify('浏览器存储空间不足，修改尚未保存。请缩小照片后重试。'); return false; }
}
// A single shared seed makes teacher and child previews use the same identities.
if (!read(STORE_KEY,null)) persist(data);
function completion(person,date=today) {
  if (records().some(r=>r.child?.id===person.id && recordDate(r)===date)) return '已记录';
  const draft=read(DRAFT_KEY,{})[person.id];
  if (draft && (draft.activityDate ?? dateKey(new Date(draft.createdAt)))===date && (draft.pendingText || draft.turns?.some(t=>t.role==='child'))) return '进行中';
  return '待交流';
}
function pageHead(title,description,action='') {
  return `<div class="page-head"><div><p class="eyebrow">LITTLE MOMENTS, WELL KEPT</p><h1>${title}</h1><p class="subline">${description}</p></div>${action}</div>`;
}
function dayIds(date) { return rosterFor(data,date).map(c=>c.id); }
function loadDay(date) { selectedDate=date; month=date.slice(0,7); selectedIds=dayIds(date); dirty=false; }
loadDay(today);
function confirmDiscard(callback) {
  if (!dirty) { callback(); return; }
  openDialog(`<div class="dialog-head"><h2 id="dialog-title">这天的安排还没保存</h2></div><p class="subline">${dateText(selectedDate)}的名单有修改，可以保存后继续，也可以放弃这次修改。</p><div class="dialog-actions"><button class="button" id="stay">继续编辑</button><button class="button" id="discard">放弃修改</button><button class="button primary" id="save-then">保存并继续</button></div>`);
  $('#stay').onclick=()=>{closeDialog();render();};
  $('#discard').onclick=()=>{dirty=false;closeDialog();callback();};
  $('#save-then').onclick=()=>{if(saveDay(false)){closeDialog();callback();}};
}
function saveDay(rerender=true) {
  const next=structuredClone(data);next.schedules[selectedDate]=[...selectedIds];
  if(!persist(next))return false;
  dirty=false; if(rerender)render(); notify(`${dateText(selectedDate)}的安排已保存 · ${selectedIds.length} 人`);return true;
}
function render() {
  const nextView=location.hash.slice(1);view=names[nextView]?nextView:'schedule';
  if(nextView&&!names[nextView])history.replaceState(null,'','#schedule');
  $('#breadcrumb').textContent=names[view];
  const entryDate=view==='schedule'?selectedDate:today;
  $('#child-entry').href=`index.html?roster=${entryDate}`;
  $('#child-entry').textContent=entryDate===today?'进入儿童端 ↗':`预览 ${asDate(entryDate).getMonth()+1} 月 ${asDate(entryDate).getDate()} 日儿童端 ↗`;
  document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  $('#teacher-main').innerHTML=({schedule:schedulePage,children:()=>profilesPage('children'),ducks:()=>profilesPage('ducks'),records:recordsPage}[view])();
  bindView();
}
function schedulePage(){
  const first=asDate(`${month}-01`), start=shiftDay(dateKey(first),-((first.getDay()+6)%7));
  const numDays=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
  const cells=Math.ceil((((first.getDay()+6)%7)+numDays)/7)*7;
  let calendar='';
  for(let i=0;i<cells;i++){
    const date=shiftDay(start,i),roster=rosterFor(data,date), inMonth=date.startsWith(month);
    calendar+=`<button class="calendar-day ${!inMonth?'outside':''} ${i%7>4?'weekend':''} ${date===today?'today-mark':''} ${date===selectedDate?'selected':''}" data-date="${date}" aria-label="${dateText(date)}，${roster.length?roster.map(c=>c.name).join('、'):'未安排'}" aria-pressed="${date===selectedDate}" tabindex="${date===selectedDate?0:-1}"><span class="day-number"><b>${asDate(date).getDate()}</b>${date===today?'<small>今天</small>':''}${roster.length>2?`<small class="more-count">${roster.length}人</small>`:''}</span><span class="day-chips">${roster.slice(0,2).map(c=>`<span class="day-chip ${completion(c,date)==='已记录'?'done':''}">${completion(c,date)==='已记录'?'✓ ':''}${esc(c.name)}</span>`).join('')}${!roster.length&&inMonth?'<span class="day-empty">—</span>':''}</span></button>`;
  }
  const scheduled=Object.keys(data.schedules).filter(d=>d.startsWith(month)&&rosterFor(data,d).length).length;
  return `${pageHead('把照顾小鸭的日子，安排好。','整月看安排，点一天就能调整。给每个孩子留一个参与的机会。')}
  <div class="toolbar"><div class="row"><h2>${first.getFullYear()} 年 ${first.getMonth()+1} 月</h2><button class="icon-button" id="prev-month" aria-label="上个月">‹</button><button class="icon-button" id="next-month" aria-label="下个月">›</button><button class="button compact" id="back-today">今天</button></div><div class="row"><label class="sr-only" for="jump-date">跳转到日期</label><input class="jump-date" id="jump-date" type="date" value="${selectedDate}" aria-label="跳转到日期"><button class="button compact" id="copy-week">复用一周安排</button></div></div>
  <div class="calendar-layout"><div><section class="panel calendar-panel" aria-label="月历"><div class="weekdays">${['一','二','三','四','五','六','日'].map(d=>`<span>周${d}</span>`).join('')}</div><div class="calendar-grid" style="--weeks:${cells/7}" role="group" aria-label="选择排班日期">${calendar}</div><div class="calendar-foot"><span class="legend"><i class="dot"></i>已安排</span><span class="legend"><i class="dot green"></i>✓ 已记录</span><span>方向键选日期 · 回车编辑</span></div></section><p class="calendar-summary">本月已安排 ${scheduled} 天 · 周末也可以安排活动。<br>当前是虚构示例排班，可自由修改体验。</p></div><section class="panel day-editor" aria-label="当天安排">${dayEditor()}</section></div>`;
}
function dayEditor(){
  const d=asDate(selectedDate);
  return `<p class="eyebrow">${selectedDate===today?'TODAY · 今天':'DAY PLAN · 当天安排'}</p><h2 class="date-big">${d.getMonth()+1} 月 ${d.getDate()} 日<small>${d.toLocaleDateString('zh-CN',{weekday:'long'})}</small></h2><span id="save-state" class="saved-label ${dirty?'unsaved':''}">${dirty?'有修改，尚未保存':'已保存的安排'}</span><div class="row spread label"><span>选择当天的幼儿</span><span id="selected-count">已选 ${selectedIds.length} 位</span></div><div class="child-picker">${activeChildren().map(c=>`<label class="pick-child">${personAvatar(c)}<span><strong>${esc(c.name)}</strong><small>${esc(c.fullName||c.name)}</small></span><input type="checkbox" value="${esc(c.id)}" ${selectedIds.includes(c.id)?'checked':''} aria-label="安排${esc(c.name)}"></label>`).join('')||'<p class="subline">先到幼儿管理添加一位孩子。</p>'}</div><button class="button primary wide" id="save-day" ${dirty?'':'disabled'}>保存当天安排</button><button class="button subtle wide" id="copy-previous">沿用上周${d.toLocaleDateString('zh-CN',{weekday:'long'}).replace('星期','周').replace('周','')}的名单</button>`;
}
function duckArt(d){
  if(d.photo)return `<img src="${esc(d.photo)}" alt="${esc(d.name)}的照片">`;
  const body=d.color==='gold'?'#f6d985':'#fffdf1';
  return `<svg viewBox="0 0 180 140" aria-hidden="true"><ellipse cx="93" cy="121" rx="52" ry="7" fill="#534628" opacity=".08"/><path d="M74 106l-7 15 20-1M112 107l2 15 19-3" fill="#dd9b55"/><path d="M34 75q-17-10-12-24 20 2 34 11" fill="${body}"/><ellipse cx="86" cy="86" rx="49" ry="34" fill="${body}"/><circle cx="119" cy="48" r="30" fill="${body}"/><path d="M142 48q26 1 22 11-16 8-29-1" fill="#e9a155"/><circle cx="128" cy="43" r="3" fill="#514334"/><path d="M62 76q15-11 29 0-4 19-22 19" stroke="#c2a774" stroke-width="2" fill="none" opacity=".45"/>${d.color==='sage'?'<path d="M104 20q17-10 27 4l-20 7z" fill="#7b725f"/>':''}</svg>`;
}
function profilesPage(kind){
  const isChild=kind==='children', label=isChild?'幼儿':'小鸭';
  const list=data[kind].filter(c=>Boolean(c.active)!==showArchived && `${c.name} ${c.fullName||''} ${c.note||''}`.includes(search));
  return `${pageHead(isChild?'认识每一张可爱的脸。':'小鸭们，也有自己的小档案。',isChild?'照片帮助孩子认出自己，小名让鸭鸭叫得更亲切。':'记下名字和容易辨认的特征，方便孩子讲、老师查。',`<button class="button primary" id="add-profile">＋ 添加${label}</button>`)}<div class="filters"><input class="search" id="profile-search" type="search" placeholder="${isChild?'搜索姓名或小名':'搜索名字或特征'}" aria-label="搜索${label}" value="${esc(search)}"><select id="archive-filter" aria-label="档案状态"><option value="active" ${!showArchived?'selected':''}>${isChild?'在班幼儿':'正在照顾'}</option><option value="archived" ${showArchived?'selected':''}>已归档</option></select><small>共 ${list.length} ${isChild?'位':'只'}</small></div><div class="profile-grid ${kind}">${list.map(c=>`<article class="panel profile-card ${!c.active?'archived':''}">${isChild?personAvatar(c):`<div class="duck-portrait ${esc(c.color||'cream')}">${duckArt(c)}</div>`}<h2>${esc(c.name)}<small>${isChild?esc(c.fullName||''):c.active?'正在照顾':'已归档'}</small></h2><p class="profile-note">${esc(c.note|| (isChild?'还没有特别备注。':'还没有填写小鸭的特征。'))}</p><div class="card-bottom"><span>${isChild?`${records().filter(r=>r.child?.id===c.id).length} 篇小故事`:'名字与特征可用于核对记录'}</span><button data-edit="${esc(c.id)}">编辑资料 ↗</button></div></article>`).join('')}</div>${!list.length?'<div class="panel empty">这里还没有匹配的档案。可以调整筛选，或添加一份新资料。</div>':''}<p class="calendar-summary">${isChild?'示例头像和姓名均为虚构；上传照片在本原型中仅保存在当前浏览器。':'卡片中的小鸭插画用于示意，可以上传照片替换。陪伴孩子聊天的鸭鸭 IP 始终保持独立。'}</p>`;
}
function recordsPage(){
  const list=records().filter(r=>(!recordChild||r.child?.id===recordChild)&&(recordFilter==='all'||(recordFilter==='pending'?!r.reviewedAt:Boolean(r.reviewedAt))));
  return `${pageHead('把小小的发现，好好收藏。','对照原话核对记录，让孩子的故事保持孩子自己的样子。')}<div class="records-toolbar"><select id="record-child" aria-label="按幼儿筛选"><option value="">全部幼儿</option>${data.children.map(c=>`<option value="${esc(c.id)}" ${recordChild===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select><select id="record-filter" aria-label="核对状态"><option value="all" ${recordFilter==='all'?'selected':''}>全部记录</option><option value="pending" ${recordFilter==='pending'?'selected':''}>待核对</option><option value="reviewed" ${recordFilter==='reviewed'?'selected':''}>已核对</option></select></div>${list.map(r=>`<article class="panel record-card"><div class="row">${r.child?personAvatar(r.child):''}<h3>${esc(r.child?.name||'旧版示例')}的小故事</h3><span class="status ${r.reviewedAt?'done':''}">${r.reviewedAt?'已核对':'待核对'}</span></div><p>${esc(r.text)}</p><div class="row spread"><span class="record-meta">${dateText(recordDate(r))}</span><button class="button" data-review="${esc(r.id)}">${r.reviewedAt?'查看与修改':'核对原话'}</button></div></article>`).join('')||'<div class="panel empty"><span class="empty-icon">▤</span>这里还没有故事。<br>在儿童端完成一次交流并保存，就能回到这里核对。<br><a class="button primary" href="index.html?roster=today">去儿童端体验 ↗</a></div>'}`;
}
function bindView(){
  document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>editRecord(b.dataset.review));
  if(view==='schedule'){
    document.querySelectorAll('[data-date]').forEach(b=>{
      b.onclick=()=>confirmDiscard(()=>{loadDay(b.dataset.date);render();});
      b.onkeydown=e=>{
        const deltas={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
        if(e.key in deltas){e.preventDefault();confirmDiscard(()=>{loadDay(shiftDay(b.dataset.date,deltas[e.key]));render();$(`[data-date="${selectedDate}"]`)?.focus();});}
        if(e.key==='Enter'){e.preventDefault();$('.pick-child input')?.focus();}
      };
    });
    $('#prev-month').onclick=()=>changeMonth(-1);$('#next-month').onclick=()=>changeMonth(1);
    $('#back-today').onclick=()=>confirmDiscard(()=>{loadDay(today);render();});
    $('#jump-date').onchange=e=>{const date=e.target.value;if(date)confirmDiscard(()=>{loadDay(date);render();});};
    $('.child-picker').onchange=()=>{selectedIds=[...document.querySelectorAll('.pick-child input:checked')].map(i=>i.value);markDirty();};
    $('#save-day').onclick=()=>saveDay();
    $('#copy-previous').onclick=()=>{selectedIds=dayIds(shiftDay(selectedDate,-7));dirty=JSON.stringify(selectedIds)!==JSON.stringify(dayIds(selectedDate));render();notify(selectedIds.length?'已带入上周名单，检查后保存。':'上周这天没有安排，可直接勾选幼儿。');};
    $('#copy-week').onclick=copyWeekDialog;
  }
  if(view==='children'||view==='ducks'){
    $('#add-profile').onclick=()=>editProfile(view);
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editProfile(view,b.dataset.edit));
    $('#profile-search').oninput=e=>{const position=e.target.selectionStart;search=e.target.value;render();$('#profile-search').focus();$('#profile-search').setSelectionRange(position,position);};
    $('#archive-filter').onchange=e=>{showArchived=e.target.value==='archived';render();};
  }
  if(view==='records'){
    $('#record-child').onchange=e=>{recordChild=e.target.value;render();};
    $('#record-filter').onchange=e=>{recordFilter=e.target.value;render();};
  }
}
function markDirty(){dirty=JSON.stringify([...selectedIds].sort())!==JSON.stringify([...dayIds(selectedDate)].sort());$('#save-day').disabled=!dirty;$('#selected-count').textContent=`已选 ${selectedIds.length} 位`;$('#save-state').textContent=dirty?'有修改，尚未保存':'已保存的安排';$('#save-state').classList.toggle('unsaved',dirty);}
function changeMonth(delta){confirmDiscard(()=>{const d=asDate(`${month}-01`);d.setMonth(d.getMonth()+delta);loadDay(dateKey(d));render();});}
function openDialog(html){dialogReturnFocus=document.activeElement;const dialog=$('#editor-dialog');dialog.innerHTML=html;if(!dialog.open)dialog.showModal();}
function closeDialog(){ $('#editor-dialog').close();dialogReturnFocus?.focus(); }
function copyWeekDialog(){
  confirmDiscard(()=>{
    const weekStart=shiftDay(selectedDate,-((asDate(selectedDate).getDay()+6)%7));
    openDialog(`<div class="dialog-head"><h2 id="dialog-title">复用一周安排</h2><button class="icon-button" id="close-dialog" aria-label="关闭">×</button></div><p class="subline" style="margin-bottom:22px">选好来源和目标，以周一为起点复制 7 天。已有安排的日期会保留，方便先复用、再微调。</p><label class="field">来源周的周一<input id="copy-source" type="date" value="${weekStart}" required></label><label class="field">目标周的周一<input id="copy-target" type="date" value="${shiftDay(weekStart,7)}" required></label><p id="copy-preview" class="subline"></p><p id="copy-error" class="error" role="alert"></p><div class="dialog-actions"><button class="button" id="cancel-copy">取消</button><button class="button primary" id="confirm-copy">复制到空白日期</button></div>`);
    const preview=()=>{const source=$('#copy-source').value,target=$('#copy-target').value;if(!source||!target)return;let add=0,skip=0;for(let i=0;i<7;i++){if(dayIds(shiftDay(source,i)).length){if(dayIds(shiftDay(target,i)).length)skip++;else add++;}}$('#copy-preview').textContent=`预计填入 ${add} 天，保留 ${skip} 天已有安排。`;};
    $('#copy-source').onchange=preview;$('#copy-target').onchange=preview;preview();
    $('#close-dialog').onclick=closeDialog;$('#cancel-copy').onclick=closeDialog;
    $('#confirm-copy').onclick=()=>{
      const source=$('#copy-source').value,target=$('#copy-target').value;
      if(!source||!target||asDate(source).getDay()!==1||asDate(target).getDay()!==1){$('#copy-error').textContent='请选择来源周和目标周的周一。';return;}
      const next=structuredClone(data);let count=0;
      for(let i=0;i<7;i++){const from=shiftDay(source,i),to=shiftDay(target,i),ids=dayIds(from);if(ids.length&&!dayIds(to).length){next.schedules[to]=ids;count++;}}
      if(!persist(next))return;closeDialog();loadDay(target);render();notify(count?`已复用 ${count} 天安排，已有安排均保留。`:'没有需要填入的日期，已有安排保持不变。');
    };
  });
}
function editProfile(kind,id){
  const isChild=kind==='children',label=isChild?'幼儿':'小鸭';
  const original=data[kind].find(c=>c.id===id),p=original?structuredClone(original):{id:crypto.randomUUID(),name:'',fullName:'',note:'',avatar:null,color:'cream',active:true};
  openDialog(`<form id="profile-form"><div class="dialog-head"><h2 id="dialog-title">${id?'编辑':'添加'}${label}</h2><button type="button" class="icon-button" id="close-dialog" aria-label="关闭">×</button></div><div class="photo-preview"><div id="profile-photo">${isChild?personAvatar(p):`<div class="duck-portrait cream" style="width:90px;height:80px;margin:0">${duckArt(p)}</div>`}</div><div><label class="field" style="margin:0">${isChild?'头像照片':'小鸭照片'}<input type="file" id="photo-file" accept="image/png,image/jpeg,image/webp"></label><p>PNG / JPG / WebP，2 MB 以内；示例体验请使用虚构图片。</p><button type="button" class="link-text" id="remove-photo" ${p.photo?'':'disabled'}>移除照片</button></div></div>${isChild?`<label class="field">姓名<input name="fullName" value="${esc(p.fullName)}" placeholder="如：林沐沐" required maxlength="30"></label>`:''}<label class="field">${isChild?'小名 · 儿童端显示与语音称呼':'小鸭名字'}<input name="name" value="${esc(p.name)}" placeholder="${isChild?'如：沐沐':'如：小黄'}" required maxlength="20"></label><label class="field">${isChild?'教师备注（选填）':'外观特征与备注（选填）'}<textarea name="note" rows="3" maxlength="300" placeholder="${isChild?'记下交流时需要留意的小事':'比如羽毛颜色、容易辨认的特征'}">${esc(p.note)}</textarea></label><p class="error" id="profile-error" role="alert"></p><div class="dialog-actions">${id?`<button type="button" class="button subtle ${p.active?'danger':''}" id="archive-profile" style="margin-right:auto">${p.active?'归档':'恢复档案'}</button>`:''}<button type="button" class="button" id="cancel-profile">取消</button><button class="button primary" type="submit">保存资料</button></div></form>`);
  $('#close-dialog').onclick=closeDialog;$('#cancel-profile').onclick=closeDialog;
  const profileForm=$('#profile-form');
  $('#remove-photo').onclick=()=>{delete p.photo;$('#photo-file').value='';$('#remove-photo').disabled=true;$('#profile-photo').innerHTML=isChild?personAvatar(p):`<div class="duck-portrait cream" style="width:90px;height:80px;margin:0">${duckArt(p)}</div>`;};
  $('#photo-file').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    if(file.size>2*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type)){$('#profile-error').textContent='请选择 2 MB 以内的 PNG、JPG 或 WebP 图片。';return;}
    const url=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file);});
    if($('#profile-form')!==profileForm)return;p.photo=url;$('#remove-photo').disabled=false;$('#profile-error').textContent='';$('#profile-photo').innerHTML=isChild?personAvatar(p):`<div class="duck-portrait" style="width:90px;height:80px;margin:0">${duckArt(p)}</div>`;
  };
  $('#profile-form').onsubmit=e=>{e.preventDefault();const fields=new FormData(e.target);p.name=fields.get('name').trim();p.note=fields.get('note').trim();if(isChild)p.fullName=fields.get('fullName').trim();if(!p.name||(isChild&&!p.fullName)){$('#profile-error').textContent='请填好姓名或名字。';return;}const next=structuredClone(data),index=next[kind].findIndex(c=>c.id===p.id);if(index<0)next[kind].push(p);else next[kind][index]=p;if(!persist(next))return;closeDialog();render();notify(`${p.name}的资料已保存。`);};
  if(id)$('#archive-profile').onclick=()=>{
    if(p.active){
      $('#profile-error').innerHTML=`归档后将不再出现在新的${isChild?'排班选择和儿童入口':'小鸭选择'}中，已有记录保留。<button type="button" class="button danger" id="confirm-archive" style="margin-top:10px">确认归档${esc(p.name)}</button>`;
      $('#confirm-archive').onclick=()=>setActive(false);
    }else setActive(true);
  };
  function setActive(active){const next=structuredClone(data);next[kind].find(c=>c.id===id).active=active;if(!persist(next))return;selectedIds=dayIds(selectedDate);closeDialog();render();notify(`${p.name}已${active?'恢复':'归档'}，历史记录保留。`);}
}
function editRecord(id){
  const r=records().find(r=>r.id===id);if(!r)return;
  openDialog(`<form id="review-form"><div class="dialog-head"><h2 id="dialog-title">核对${esc(r.child?.name||'孩子')}的故事</h2><button type="button" class="icon-button" id="close-dialog" aria-label="关闭">×</button></div><label class="field">整理后的记录<textarea id="review-text" rows="5" required>${esc(r.text)}</textarea></label><p class="subline">对照原话修改，不添加孩子没有表达的内容。</p><div class="record-original">${(r.turns||[]).map(t=>`<strong>${t.role==='child'?'孩子':'鸭鸭'}</strong>：${esc(t.text)}`).join('\n\n')||'这条旧记录没有保留对话原文。'}</div><p id="review-error" class="error" role="alert"></p><div class="dialog-actions"><button type="button" class="button" id="cancel-review">取消</button><button class="button primary" type="submit">保存并标记已核对</button></div></form>`);
  $('#close-dialog').onclick=closeDialog;$('#cancel-review').onclick=closeDialog;
  $('#review-form').onsubmit=e=>{e.preventDefault();const text=$('#review-text').value.trim();if(!text){$('#review-error').textContent='请保留一段记录内容。';return;}const next=records().map(item=>item.id===id?{...item,text,reviewedAt:new Date().toISOString()}:item);try{localStorage.setItem(RECORDS_KEY,JSON.stringify(next));}catch{notify('没有保存成功，请先复制修改后的内容。');return;}closeDialog();render();notify('记录已保存，并标记为已核对。');};
}
document.querySelectorAll('nav a,.brand,#child-entry').forEach(a=>a.addEventListener('click',e=>{if(dirty){e.preventDefault();const href=a.getAttribute('href');confirmDiscard(()=>location.href=href);}}));
window.addEventListener('hashchange',()=>{search='';showArchived=false;if(dirty){const desired=location.hash;history.replaceState(null,'',`#${view}`);confirmDiscard(()=>{loadDay(selectedDate);location.hash=desired;});return;}loadDay(selectedDate);render();});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('storage',e=>{if([STORE_KEY,RECORDS_KEY,DRAFT_KEY].includes(e.key)&&!dirty&&!$('#editor-dialog').open){data=loadData();loadDay(selectedDate);render();}});
render();
