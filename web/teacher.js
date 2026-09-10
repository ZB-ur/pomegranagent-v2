import {cropPhoto} from './crop.mjs';
import {matchesChildName} from './name-search.mjs';
import {STORE_KEY,RECORDS_KEY,DRAFT_KEY,escape as esc,dateKey,asDate,shiftDay,read,loadData,saveData,rosterFor,draftFor,personAvatar,recordDate,write,refresh,api} from './store.mjs';
const $ = selector => document.querySelector(selector);
let data = loadData();
const today = dateKey();
let selectedDate = today, month = today.slice(0,7), selectedIds = [], dirty = false;
let view = '', search = '', showArchived = false, recordChild = '', recordFilter = 'all', recordDay = '';
let toastTimer, dialogReturnFocus;
let daySearch = '', dayDrawerOpen = false;
const narrowSchedule=matchMedia('(max-width:940px)');
const names = {schedule:'排班日历',children:'幼儿管理',ducks:'小鸭管理',records:'故事记录'};
const dateText = value => asDate(value).toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
const records = () => read(RECORDS_KEY,[]);
const activeChildren = () => data.children.filter(c=>c.active);
const studentLabel = child => Number.isSafeInteger(child.studentNumber) ? `学号 ${child.studentNumber}` : '';
function duplicateNumber(child){return child.active && Number.isSafeInteger(child.studentNumber) && data.children.some(c=>c.active&&c.id!==child.id&&c.studentNumber===child.studentNumber);}
function notify(message) { const dialog=$('#editor-dialog');if(dialog.open){let inline=dialog.querySelector('[data-service-error]');if(!inline){inline=document.createElement('p');inline.dataset.serviceError='';inline.className='form-error';inline.setAttribute('role','alert');dialog.append(inline);}inline.textContent=message;} $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,4200); }
let persisting=false;
async function persist(next) {
  if(persisting)return false;const focus=document.activeElement;persisting=true;$('#teacher-main').inert=true;$('#editor-dialog').inert=true;
  try { await saveData(next); data=loadData(); return true; }
  catch { notify('没有保存成功。请保留当前编辑，检查服务；其他窗口修改过资料时，请刷新后重新核对。'); return false; }
  finally{persisting=false;$('#teacher-main').inert=false;$('#editor-dialog').inert=false;if(focus?.isConnected)focus.focus();}
}
// Teacher and child read the same local database.

function completion(person,date=today) {
  if (records().some(r=>r.child?.id===person.id && recordDate(r)===date)) return '已记录';
  const draft=draftFor(read(DRAFT_KEY,{}),person.id,date);
  if (draft && (draft.activityDate ?? dateKey(new Date(draft.createdAt)))===date && (draft.pendingText || draft.turns?.some(t=>t.role==='child'))) return '进行中';
  return '待交流';
}
function pageHead(title,description,action='') {
  return `<div class="page-head"><div><p class="eyebrow">LITTLE MOMENTS, WELL KEPT</p><h1>${title}</h1><p class="subline">${description}</p></div>${action}</div>`;
}
function dayIds(date) { return rosterFor(data,date).map(c=>c.id); }
function loadDay(date) { selectedDate=date; month=date.slice(0,7); selectedIds=dayIds(date); dirty=false; daySearch=''; }
loadDay(today);
function confirmDiscard(callback) {
  if (!dirty) { callback(); return; }
  openDialog(`<div class="dialog-head"><h2 id="dialog-title">这天的安排还没保存</h2></div><p class="subline">${dateText(selectedDate)}的名单有修改，可以保存后继续，也可以放弃这次修改。</p><div class="dialog-actions"><button class="button" id="stay">继续编辑</button><button class="button" id="discard">放弃修改</button><button class="button primary" id="save-then">保存并继续</button></div>`);
  $('#stay').onclick=()=>{closeDialog();render();};
  $('#discard').onclick=()=>{dirty=false;closeDialog();callback();};
  $('#save-then').onclick=async()=>{if(await saveDay(false)){closeDialog();callback();}};
}
async function saveDay(rerender=true) {
  const next=structuredClone(data);next.schedules[selectedDate]=[...selectedIds];
  if(!await persist(next))return false;
  dirty=false; if(rerender)render(); notify(`${dateText(selectedDate)}的安排已保存 · ${selectedIds.length} 人`);return true;
}
function render() {
  const focused=document.activeElement;
  let focusSelector;
  if($('#teacher-main').contains(focused)){
    if(focused.id)focusSelector=`#${CSS.escape(focused.id)}`;
    else for(const attribute of ['data-date','data-edit','data-review']){
      if(focused.hasAttribute(attribute)){focusSelector=`[${attribute}="${CSS.escape(focused.getAttribute(attribute))}"]`;break;}
    }
  }
  const nextView=location.hash.slice(1);view=names[nextView]?nextView:'schedule';
  if(nextView&&!names[nextView])history.replaceState(null,'','#schedule');
  document.body.classList.toggle('schedule-view',view==='schedule');
  $('#breadcrumb').textContent=names[view];
  const entryDate=today;
  $('#child-entry').href=`index.html?roster=${entryDate}`;
  $('#child-entry').textContent=entryDate===today?'进入儿童端 ↗':`预览 ${asDate(entryDate).getMonth()+1} 月 ${asDate(entryDate).getDate()} 日儿童端 ↗`;
  document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  $('#teacher-main').innerHTML=({schedule:schedulePage,children:()=>profilesPage('children'),ducks:()=>profilesPage('ducks'),records:recordsPage}[view])();
  bindView();
  if(focusSelector){
    const replacement=$(focusSelector);
    if(replacement&&!replacement.disabled)replacement.focus();
    else if(view==='schedule')$(`[data-date="${selectedDate}"]`)?.focus();
    else $('#add-profile')?.focus();
  }
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
  return `<h1 class="sr-only">排班日历</h1>
  <div class="toolbar"><div class="row"><h2>${first.getFullYear()} 年 ${first.getMonth()+1} 月</h2><button class="icon-button" id="prev-month" aria-label="上个月">‹</button><button class="icon-button" id="next-month" aria-label="下个月">›</button><button class="button compact" id="back-today">今天</button></div><div class="row"><label class="sr-only" for="jump-date">跳转到日期</label><input class="jump-date" id="jump-date" type="date" value="${selectedDate}" aria-label="跳转到日期"><details class="schedule-reuse" id="reuse-menu"><summary class="button compact">复用安排 ▾</summary><div class="reuse-options"><p>当前选择：${dateText(selectedDate)}</p><button id="copy-previous">沿用上周同日名单</button><button id="copy-week">复制整周安排…</button></div></details></div></div>
  <div class="calendar-layout"><div><section class="panel calendar-panel" aria-label="月历"><div class="weekdays">${['一','二','三','四','五','六','日'].map(d=>`<span>周${d}</span>`).join('')}</div><div class="calendar-grid" style="--weeks:${cells/7}" role="group" aria-label="选择排班日期">${calendar}</div><div class="calendar-foot"><span class="legend"><i class="dot"></i>已安排</span><span class="legend"><i class="dot green"></i>✓ 已记录</span><span>本月已安排 ${scheduled} 天</span><span class="calendar-key-hint">方向键选日期 · 回车编辑</span></div></section></div>${narrowSchedule.matches?`<dialog id="day-drawer" aria-label="当天安排"><section class="panel day-editor">${dayEditor()}</section></dialog>`:`<section class="panel day-editor" aria-label="当天安排">${dayEditor()}</section>`}</div>`;
}
function dayEditor(){
  const d=asDate(selectedDate);
  return `<div class="day-editor-heading"><h2 class="date-big">${d.getMonth()+1}月${d.getDate()}日<small>${d.toLocaleDateString('zh-CN',{weekday:'short'})}</small></h2>${narrowSchedule.matches?'<button id="close-day" class="icon-button" aria-label="关闭当天安排">×</button>':''}</div><span id="save-state" class="saved-label ${dirty?'unsaved':''}">${dirty?'有修改，尚未保存':'已保存的安排'}</span><section class="selected-roster" aria-label="已选幼儿"><div class="row spread selected-roster-heading"><strong id="selected-count">已选 ${selectedIds.length} 位</strong><button type="button" id="toggle-selected" aria-haspopup="dialog" ${selectedIds.length>4?'':'hidden'}>查看全部</button></div><div id="selected-roster-list" class="selected-roster-list"></div></section><div class="day-search-row"><label class="sr-only" for="day-child-search">搜索幼儿学号、姓名、小名或拼音首字母</label><input id="day-child-search" type="search" placeholder="学号 / 姓名 / 小名首字母" value="${esc(daySearch)}" autocomplete="off" aria-describedby="day-search-hint day-match-count"><button type="button" class="button compact" id="clear-day-search" ${daySearch?'':'hidden'}>清空</button></div><p id="day-search-hint" class="sr-only">学号完整匹配；姓名 / 小名首字母如 XH。</p><p id="day-match-count" class="day-match-count" role="status" aria-live="polite"></p><div class="child-picker">${activeChildren().map(c=>`<label class="pick-child" data-pick-child="${esc(c.id)}">${personAvatar(c)}${studentLabel(c)?`<b class="picker-number" title="学号 ${c.studentNumber}">${c.studentNumber}</b>`:'<span class="picker-number-slot" aria-hidden="true"></span>'}<span class="picker-name"><strong>${esc(c.fullName||c.name)}</strong>${c.fullName&&c.fullName!==c.name?`<small>小名：${esc(c.name)}</small>`:''}</span><input type="checkbox" value="${esc(c.id)}" ${selectedIds.includes(c.id)?'checked':''} aria-label="安排${esc(c.name)}"></label>`).join('')||'<p class="subline">先到幼儿管理添加一位孩子。</p>'}</div><p id="day-search-empty" class="day-search-empty" hidden>没有找到这位幼儿，请输入完整学号或姓名，也可清空搜索。</p><div class="day-editor-actions"><button class="button primary" id="save-day" ${dirty?'':'disabled'}>保存安排</button>${selectedDate<today?'<button class="button backfill-entry" id="backfill-day">补录故事 ↗</button>':''}</div>`;
}
function duckArt(d){
  if(d.photo)return `<img src="${esc(d.photo)}" alt="${esc(d.name)}的照片">`;
  const body=d.color==='gold'?'#f6d985':'#fffdf1';
  return `<svg viewBox="0 0 180 140" aria-hidden="true"><ellipse cx="93" cy="121" rx="52" ry="7" fill="#534628" opacity=".08"/><path d="M74 106l-7 15 20-1M112 107l2 15 19-3" fill="#dd9b55"/><path d="M34 75q-17-10-12-24 20 2 34 11" fill="${body}"/><ellipse cx="86" cy="86" rx="49" ry="34" fill="${body}"/><circle cx="119" cy="48" r="30" fill="${body}"/><path d="M142 48q26 1 22 11-16 8-29-1" fill="#e9a155"/><circle cx="128" cy="43" r="3" fill="#514334"/><path d="M62 76q15-11 29 0-4 19-22 19" stroke="#c2a774" stroke-width="2" fill="none" opacity=".45"/>${d.color==='sage'?'<path d="M104 20q17-10 27 4l-20 7z" fill="#7b725f"/>':''}</svg>`;
}
function profilesPage(kind){
  const isChild=kind==='children', label=isChild?'幼儿':'小鸭';
  const list=data[kind].filter(c=>Boolean(c.active)!==showArchived && (isChild?matchesChildName(c,search):`${c.name} ${c.note||''}`.includes(search)));
  return `${pageHead(isChild?'认识每一张可爱的脸。':'小鸭们，也有自己的小档案。',isChild?'照片帮助孩子认出自己，小名让鸭鸭叫得更亲切。':'记下名字和容易辨认的特征，方便孩子讲、老师查。',`<button class="button primary" id="add-profile">＋ 添加${label}</button>`)}<div class="filters"><input class="search" id="profile-search" type="search" placeholder="${isChild?'完整学号 / 姓名 / 小名首字母':'搜索名字或特征'}" aria-label="搜索${label}" value="${esc(search)}"><select id="archive-filter" aria-label="档案状态"><option value="active" ${!showArchived?'selected':''}>${isChild?'在班幼儿':'正在照顾'}</option><option value="archived" ${showArchived?'selected':''}>已归档</option></select><small>共 ${list.length} ${isChild?'位':'只'}</small></div><div class="profile-grid ${kind}">${list.map(c=>`<article class="panel profile-card ${!c.active?'archived':''}">${isChild?personAvatar(c):`<div class="duck-portrait ${esc(c.color||'cream')}">${duckArt(c)}</div>`}<h2>${esc(c.name)}<small>${isChild?esc(c.fullName||''):c.active?'正在照顾':'已归档'}</small></h2>${isChild&&studentLabel(c)?`<span class="student-number">${esc(studentLabel(c))}</span>`:''}<p class="profile-note">${esc(c.note|| (isChild?'还没有特别备注。':'还没有填写小鸭的特征。'))}</p><div class="card-bottom"><span>${isChild?`${records().filter(r=>r.child?.id===c.id).length} 篇小故事`:'名字与特征可用于核对记录'}</span><button data-edit="${esc(c.id)}">编辑资料 ↗</button></div></article>`).join('')}</div>${!list.length?'<div class="panel empty">这里还没有匹配的档案。可以调整筛选，或添加一份新资料。</div>':''}<p class="calendar-summary">${isChild?'照片与档案保存在本机资料库，备份时一起带走。':'卡片中的小鸭插画用于示意，可以上传照片替换。陪伴孩子聊天的鸭鸭 IP 始终保持独立。'}</p>`;
}
function recordsPage(){
  const list=records().filter(r=>(!recordDay||recordDate(r)===recordDay)&&(!recordChild||r.child?.id===recordChild)&&(recordFilter==='all'||(recordFilter==='pending'?!r.reviewedAt:Boolean(r.reviewedAt))));
  return `${pageHead('把小小的发现，好好收藏。','对照原话核对记录，让孩子的故事保持孩子自己的样子。')}<div class="records-toolbar"><input id="record-day" type="date" aria-label="按日期查找记录" value="${recordDay}"><button class="button" id="clear-date">全部日期</button><button class="button" id="export-records">导出当前记录</button><select id="record-child" aria-label="按幼儿筛选"><option value="">全部幼儿</option>${data.children.map(c=>`<option value="${esc(c.id)}" ${recordChild===c.id?'selected':''}>${studentLabel(c)?`${esc(studentLabel(c))} · `:''}${esc(c.name)}</option>`).join('')}</select><select id="record-filter" aria-label="核对状态"><option value="all" ${recordFilter==='all'?'selected':''}>全部记录</option><option value="pending" ${recordFilter==='pending'?'selected':''}>待核对</option><option value="reviewed" ${recordFilter==='reviewed'?'selected':''}>已核对</option></select></div>${list.map(r=>`<article class="panel record-card"><div class="row">${r.child?personAvatar(r.child):''}<h3>${esc(r.child?.name||'旧版示例')}的小故事</h3><span class="status ${r.reviewedAt?'done':''}">${r.reviewedAt?'已核对':'待核对'}</span></div>${r.summaryFallback&&!r.reviewedAt?'<p class="subline">自动整理未完成，已保留识别原文，请老师核对。</p>':''}<p>${esc(r.text)}</p><div class="row spread"><span class="record-meta">${dateText(recordDate(r))}</span><button class="button" data-review="${esc(r.id)}">${r.reviewedAt?'查看与修改':'核对原话'}</button></div></article>`).join('')||(records().length?'<div class="panel empty">当前筛选没有匹配的故事。<br>可以调整日期、幼儿或核对状态，查看已保存的记录。</div>':'<div class="panel empty"><span class="empty-icon">▤</span>这里还没有故事。<br>在儿童端完成一次交流并保存，就能回到这里核对。<br><a class="button primary" href="index.html?roster=today">去儿童端体验 ↗</a></div>')}`;
}
function bindView(){
  document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>editRecord(b.dataset.review));
  if(view==='schedule'){
    document.querySelectorAll('[data-date]').forEach(b=>{
      b.onclick=()=>confirmDiscard(()=>{loadDay(b.dataset.date);dayDrawerOpen=true;render();});
      b.onkeydown=e=>{
        const deltas={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
        if(e.key in deltas){e.preventDefault();confirmDiscard(()=>{loadDay(shiftDay(b.dataset.date,deltas[e.key]));render();$(`[data-date="${selectedDate}"]`)?.focus();});}
        if(e.key==='Enter'){e.preventDefault();dayDrawerOpen=true;render();$('#day-child-search')?.focus();}
      };
    });
    $('#prev-month').onclick=()=>changeMonth(-1);$('#next-month').onclick=()=>changeMonth(1);
    $('#back-today').onclick=()=>confirmDiscard(()=>{loadDay(today);render();});
    $('#jump-date').onchange=e=>{const date=e.target.value;if(date)confirmDiscard(()=>{loadDay(date);render();});};
    $('.child-picker').onchange=()=>{selectedIds=[...document.querySelectorAll('.pick-child input:checked')].map(i=>i.value);markDirty();renderSelectedRoster();filterDayChildren(false);};
    $('#day-child-search').oninput=e=>{daySearch=e.target.value;filterDayChildren();};
    $('#day-child-search').onkeydown=e=>{
      if(e.isComposing)return;
      if(e.key==='Escape'&&daySearch){e.preventDefault();clearDaySearch();}
      if(e.key==='Enter'){e.preventDefault();$('.pick-child:not([hidden]) input')?.focus();}
    };
    $('#clear-day-search').onclick=clearDaySearch;
    $('#toggle-selected').onclick=showSelectedRoster;
    const drawer=$('#day-drawer');
    if(drawer){
      const closeDay=()=>confirmDiscard(()=>{loadDay(selectedDate);dayDrawerOpen=false;render();$(`[data-date="${selectedDate}"]`)?.focus();});
      $('#close-day').onclick=closeDay;drawer.addEventListener('cancel',e=>{e.preventDefault();closeDay();});
      if(dayDrawerOpen)drawer.showModal();
    }
    renderSelectedRoster();
    filterDayChildren();
    $('#save-day').onclick=()=>saveDay();
    if($('#backfill-day'))$('#backfill-day').onclick=()=>confirmDiscard(()=>{
      loadDay(selectedDate);
      if(!dayIds(selectedDate).length){render();notify('请先为这天安排至少一位幼儿并保存，再进入补录。');$('#day-child-search')?.focus();return;}
      location.href=`index.html?date=${selectedDate}`;
    });
    $('#copy-previous').onclick=()=>{selectedIds=dayIds(shiftDay(selectedDate,-7));dirty=JSON.stringify(selectedIds)!==JSON.stringify(dayIds(selectedDate));render();notify(selectedIds.length?'已带入上周名单，检查后保存。':'上周这天没有安排，可直接勾选幼儿。');};
    $('#copy-week').onclick=()=>{$('#reuse-menu').open=false;copyWeekDialog();};
    $('#reuse-menu').onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.currentTarget.open=false;e.currentTarget.querySelector('summary').focus();}};
  }
  if(view==='children'||view==='ducks'){
    $('#add-profile').onclick=()=>editProfile(view);
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editProfile(view,b.dataset.edit));
    $('#profile-search').oninput=e=>{const position=e.target.selectionStart;search=e.target.value;render();$('#profile-search').focus();$('#profile-search').setSelectionRange(position,position);};
    $('#archive-filter').onchange=e=>{showArchived=e.target.value==='archived';render();};
  }
  if(view==='records'){
    $('#record-day').onchange=e=>{recordDay=e.target.value;render();};
    $('#clear-date').onclick=()=>{recordDay='';render();};
    $('#export-records').onclick=()=>{const list=records().filter(r=>(!recordDay||recordDate(r)===recordDay)&&(!recordChild||r.child.id===recordChild)&&(recordFilter==='all'||(recordFilter==='pending'?!r.reviewedAt:Boolean(r.reviewedAt))));const content=list.map(r=>`${r.child.name} · ${recordDate(r)}\n${r.text}\n\n对话原文\n${r.turns.map(t=>(t.role==='child'?'幼儿':'鸭鸭')+'：'+t.text).join('\n')}`).join('\n\n────────\n\n');const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='鸭鸭日记记录.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    $('#record-child').onchange=e=>{recordChild=e.target.value;render();};
    $('#record-filter').onchange=e=>{recordFilter=e.target.value;render();};
  }
}
function renderSelectedRoster(){
  const list=$('#selected-roster-list'), toggle=$('#toggle-selected');
  const chosen=selectedIds.map(id=>data.children.find(c=>c.id===id)).filter(Boolean);
  toggle.hidden=chosen.length<=4;toggle.textContent=`查看全部（${chosen.length}）`;
  list.innerHTML=chosen.length?chosen.slice(0,4).map(c=>`<button type="button" class="selected-child" data-remove-child="${esc(c.id)}" title="${esc(c.fullName||c.name)} · ${esc(c.name)}${studentLabel(c)?` · ${esc(studentLabel(c))}`:''}" aria-label="移除${esc(c.name)}的当天安排"><span class="selected-identity">${studentLabel(c)?`<b class="selected-student-number" aria-label="学号 ${c.studentNumber}">${c.studentNumber}</b>`:''}<span class="selected-name">${esc(c.name)}</span></span><span class="selected-remove" aria-hidden="true">×</span></button>`).join(''):'<p class="selected-roster-empty">还没有安排，从下面选择幼儿。</p>';
  list.querySelectorAll('[data-remove-child]').forEach((button,index)=>button.onclick=()=>{
    selectedIds=selectedIds.filter(id=>id!==button.dataset.removeChild);
    document.querySelectorAll('.pick-child input').forEach(input=>{input.checked=selectedIds.includes(input.value);});
    markDirty();renderSelectedRoster();filterDayChildren(false);
    const remaining=list.querySelectorAll('[data-remove-child]');
    (remaining[Math.min(index,remaining.length-1)]||$('#day-child-search')).focus();
  });
}
function showSelectedRoster(){
  const chosen=selectedIds.map(id=>data.children.find(c=>c.id===id)).filter(Boolean);
  openDialog(`<div class="dialog-head"><h2 id="dialog-title">${dateText(selectedDate)} · 已选 ${chosen.length} 位</h2><button class="icon-button" id="close-selected" aria-label="关闭已选名单">×</button></div><p class="subline">移除后仍需保存安排。</p><div class="selected-all-list">${chosen.map(c=>`<div class="selected-all-row">${personAvatar(c)}<span>${esc(c.fullName||c.name)}${studentLabel(c)?` · ${esc(studentLabel(c))}`:''}</span><button class="button compact" data-unselect="${esc(c.id)}" aria-label="移除${esc(c.name)}">移除</button></div>`).join('')||'<p>还没有选择幼儿。</p>'}</div><div class="dialog-actions"><button class="button primary" id="done-selected">完成</button></div>`);
  $('#close-selected').onclick=$('#done-selected').onclick=()=>closeDialog();
  document.querySelectorAll('[data-unselect]').forEach(button=>button.onclick=()=>{
    const index=chosen.findIndex(c=>c.id===button.dataset.unselect);
    selectedIds=selectedIds.filter(id=>id!==button.dataset.unselect);
    document.querySelectorAll('.pick-child input').forEach(input=>{input.checked=selectedIds.includes(input.value);});
    markDirty();renderSelectedRoster();filterDayChildren(false);showSelectedRoster();
    const buttons=document.querySelectorAll('[data-unselect]');(buttons[Math.min(index,buttons.length-1)]||$('#done-selected')).focus();
  });
  dialogReturnFocus=$('#toggle-selected').hidden?$('#day-child-search'):$('#toggle-selected');
}
function clearDaySearch(){daySearch='';$('#day-child-search').value='';filterDayChildren();$('#day-child-search').focus();}
function filterDayChildren(resetScroll=true){
  const children=activeChildren(), visible=new Set(children.filter(c=>matchesChildName(c,daySearch)).map(c=>c.id));
  document.querySelectorAll('[data-pick-child]').forEach(row=>{row.hidden=!visible.has(row.dataset.pickChild);});
  const hiddenSelected=selectedIds.filter(id=>!visible.has(id)).length;
  $('#day-match-count').textContent=daySearch.trim()?`匹配 ${visible.size} / ${children.length} 位${hiddenSelected?` · 另有 ${hiddenSelected} 位已选未显示`:''}`:`全部 ${children.length} 位幼儿`;
  $('#day-search-empty').hidden=visible.size>0||children.length===0;
  $('#clear-day-search').hidden=!daySearch;
  if(resetScroll)$('.child-picker').scrollTop=0;
}
function markDirty(){dirty=JSON.stringify([...selectedIds].sort())!==JSON.stringify([...dayIds(selectedDate)].sort());$('#save-day').disabled=!dirty;$('#selected-count').textContent=`已选 ${selectedIds.length} 位`;$('#save-state').textContent=dirty?'有修改，尚未保存':'已保存的安排';$('#save-state').classList.toggle('unsaved',dirty);}
function changeMonth(delta){confirmDiscard(()=>{const d=asDate(`${month}-01`);d.setMonth(d.getMonth()+delta);loadDay(dateKey(d));render();});}
let editorBaseline="";
function editorSignature(){const form=$("#profile-form")||$("#review-form");return form?JSON.stringify([...form.querySelectorAll("input:not([type=file]),textarea,select")].map(e=>[e.name||e.id,e.value,e.checked]))+($("#profile-photo")?.innerHTML||""):"";}
const editorDirty=()=>$('#editor-dialog').open&&editorSignature()!==editorBaseline;
function openDialog(html){dialogReturnFocus=document.activeElement;const dialog=$('#editor-dialog');dialog.innerHTML=html;editorBaseline=editorSignature();if(!dialog.open)dialog.showModal();}
function closeDialog(force=false){
  if(persisting)return;
  if(force!==true&&editorDirty()){
    if($('#unsaved-dialog'))return;
    const prompt=document.createElement('dialog');prompt.id='unsaved-dialog';prompt.setAttribute('aria-labelledby','unsaved-title');
    prompt.innerHTML='<h2 id="unsaved-title">修改还没有保存</h2><p class="subline">关闭会丢失这次修改。要先保存吗？</p><div class="dialog-actions"><button id="keep-editing" class="button">继续编辑</button><button id="discard-editor" class="button danger">放弃修改</button><button id="save-editor" class="button primary">保存并关闭</button></div>';
    document.body.append(prompt);const dismiss=()=>{prompt.close();prompt.remove();};
    prompt.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
    $('#keep-editing').onclick=dismiss;$('#discard-editor').onclick=()=>{dismiss();closeDialog(true);};
    $('#save-editor').onclick=()=>{dismiss();($('#profile-form')||$('#review-form'))?.requestSubmit();};
    prompt.showModal();$('#keep-editing').focus();return;
  }
  $('#editor-dialog').close();editorBaseline='';dialogReturnFocus?.focus();
}
function copyWeekDialog(){
  confirmDiscard(()=>{
    const weekStart=shiftDay(selectedDate,-((asDate(selectedDate).getDay()+6)%7));
    openDialog(`<div class="dialog-head"><h2 id="dialog-title">复用一周安排</h2><button class="icon-button" id="close-dialog" aria-label="关闭">×</button></div><p class="subline" style="margin-bottom:22px">选好来源和目标，以周一为起点复制 7 天。已有安排的日期会保留，方便先复用、再微调。</p><label class="field">来源周的周一<input id="copy-source" type="date" value="${weekStart}" required></label><label class="field">目标周的周一<input id="copy-target" type="date" value="${shiftDay(weekStart,7)}" required></label><p id="copy-preview" class="subline"></p><p id="copy-error" class="error" role="alert"></p><div class="dialog-actions"><button class="button" id="cancel-copy">取消</button><button class="button primary" id="confirm-copy">复制到空白日期</button></div>`);
    const preview=()=>{const source=$('#copy-source').value,target=$('#copy-target').value;if(!source||!target)return;let add=0,skip=0;for(let i=0;i<7;i++){if(dayIds(shiftDay(source,i)).length){if(dayIds(shiftDay(target,i)).length)skip++;else add++;}}$('#copy-preview').textContent=`预计填入 ${add} 天，保留 ${skip} 天已有安排。`;};
    $('#copy-source').onchange=preview;$('#copy-target').onchange=preview;preview();
    $('#close-dialog').onclick=closeDialog;$('#cancel-copy').onclick=closeDialog;
    $('#confirm-copy').onclick=async()=>{
      const source=$('#copy-source').value,target=$('#copy-target').value;
      if(!source||!target||asDate(source).getDay()!==1||asDate(target).getDay()!==1){$('#copy-error').textContent='请选择来源周和目标周的周一。';return;}
      const next=structuredClone(data);let count=0;
      for(let i=0;i<7;i++){const from=shiftDay(source,i),to=shiftDay(target,i),ids=dayIds(from);if(ids.length&&!dayIds(to).length){next.schedules[to]=ids;count++;}}
      if(!await persist(next))return;closeDialog();loadDay(target);render();$(`[data-date="${selectedDate}"]`)?.focus();notify(count?`已复用 ${count} 天安排，已有安排均保留。`:'没有需要填入的日期，已有安排保持不变。');
    };
  });
}
function editProfile(kind,id){
  const isChild=kind==='children',label=isChild?'幼儿':'小鸭';
  const original=data[kind].find(c=>c.id===id),p=original?structuredClone(original):{id:crypto.randomUUID(),name:'',fullName:'',note:'',avatar:null,color:'cream',active:true};
  openDialog(`<form id="profile-form"><div class="dialog-head"><h2 id="dialog-title">${id?'编辑':'添加'}${label}</h2><button type="button" class="icon-button" id="close-dialog" aria-label="关闭">×</button></div><div class="photo-preview"><div id="profile-photo">${isChild?personAvatar(p):`<div class="duck-portrait cream" style="width:90px;height:90px;margin:0">${duckArt(p)}</div>`}</div><div><label class="field" style="margin:0">${isChild?'头像照片':'小鸭照片'}<input type="file" id="photo-file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"></label><p>PNG / JPG / WebP，12 MB 以内；示例体验请使用虚构图片。</p><button type="button" class="link-text" id="remove-photo" ${p.photo?'':'disabled'}>移除照片</button></div></div>${isChild?`<label class="field">姓名<input name="fullName" value="${esc(p.fullName)}" placeholder="如：林沐沐" required maxlength="30"></label>`:''}<label class="field">${isChild?'小名 · 儿童端显示与语音称呼':'小鸭名字'}<input name="name" value="${esc(p.name)}" placeholder="${isChild?'如：沐沐':'如：小黄'}" required maxlength="20"></label>${isChild?`<label class="field">学号（选填）<input name="studentNumber" type="number" inputmode="numeric" min="1" max="9007199254740991" step="1" value="${esc(p.studentNumber??'')}" placeholder="如：25" aria-describedby="student-number-hint"><small id="student-number-hint">正整数，在班幼儿之间不可重复；留空可移除。</small></label>`:''}<label class="field">${isChild?'教师备注（选填）':'外观特征与备注（选填）'}<textarea name="note" rows="3" maxlength="300" placeholder="${isChild?'记下交流时需要留意的小事':'比如羽毛颜色、容易辨认的特征'}">${esc(p.note)}</textarea></label><p class="error" id="profile-error" role="alert"></p><div class="dialog-actions">${id?`<button type="button" class="button subtle ${p.active?'danger':''}" id="archive-profile" style="margin-right:auto">${p.active?'归档':'恢复档案'}</button>`:''}<button type="button" class="button" id="cancel-profile">取消</button><button class="button primary" type="submit">保存资料</button></div></form>`);
  $('#close-dialog').onclick=closeDialog;$('#cancel-profile').onclick=closeDialog;
  const profileForm=$('#profile-form');
  $('#remove-photo').onclick=()=>{delete p.photo;$('#photo-file').value='';$('#remove-photo').disabled=true;$('#profile-photo').innerHTML=isChild?personAvatar(p):`<div class="duck-portrait cream" style="width:90px;height:90px;margin:0">${duckArt(p)}</div>`;};
  $('#photo-file').onchange=async e=>{
    const file=e.target.files[0];e.target.value='';if(!file)return;
    let url;try{url=await cropPhoto(file);}catch(error){if($('#profile-form')===profileForm)$('#profile-error').textContent=error.message;return;}if(!url)return;
    if($('#profile-form')!==profileForm)return;p.photo=url;$('#remove-photo').disabled=false;$('#profile-error').textContent='';$('#profile-photo').innerHTML=isChild?personAvatar(p):`<div class="duck-portrait" style="width:90px;height:90px;margin:0">${duckArt(p)}</div>`;
  };
  $('#profile-form').onsubmit=async e=>{e.preventDefault();const fields=new FormData(e.target);p.name=fields.get('name').trim();p.note=fields.get('note').trim();if(isChild){p.fullName=fields.get('fullName').trim();const raw=fields.get('studentNumber').trim();if(raw){const value=Number(raw);if(!Number.isSafeInteger(value)||value<1){$('#profile-error').textContent='学号请填写有效的正整数。';return;}p.studentNumber=value;}else delete p.studentNumber;if(duplicateNumber(p)){$('#profile-error').textContent='这个学号已被另一位在班幼儿使用，请核对。';return;}}if(isChild&&!p.photo){$('#profile-error').textContent='请先上传并裁切一张清晰头像，让孩子不用认字也能找到自己。';return;}if(!p.name||(isChild&&!p.fullName)){$('#profile-error').textContent='请填好姓名或名字。';return;}const next=structuredClone(data),index=next[kind].findIndex(c=>c.id===p.id);if(index<0)next[kind].push(p);else next[kind][index]=p;if(!await persist(next))return;closeDialog(true);render();notify(`${p.name}的资料已保存。`);};
  if(id)$('#archive-profile').onclick=()=>{
    if(p.active){
      $('#profile-error').innerHTML=`归档后将不再出现在新的${isChild?'排班选择和儿童入口':'小鸭选择'}中，已有记录保留。<button type="button" class="button danger" id="confirm-archive" style="margin-top:10px">确认归档${esc(p.name)}</button>`;
      $('#confirm-archive').onclick=()=>setActive(false);
    }else setActive(true);
  };
  async function setActive(active){if(isChild&&active&&duplicateNumber({...original,active:true})){$('#profile-error').textContent='这个学号已被在班幼儿使用，请先修改或清空学号并保存，再恢复档案。';return;}const next=structuredClone(data);next[kind].find(c=>c.id===id).active=active;if(!await persist(next))return;selectedIds=dayIds(selectedDate);closeDialog(true);render();notify(`${p.name}已${active?'恢复':'归档'}，历史记录保留。`);}
}
function editRecord(id){
  const r=records().find(r=>r.id===id);if(!r)return;
  openDialog(`<form id="review-form"><div class="dialog-head"><h2 id="dialog-title">核对${esc(r.child?.name||'孩子')}的故事</h2><button type="button" class="icon-button" id="close-dialog" aria-label="关闭">×</button></div><label class="field">整理后的记录<textarea id="review-text" rows="5" required>${esc(r.text)}</textarea></label><p class="subline">对照原话修改，不添加孩子没有表达的内容。</p><label class="field">明确提到的小鸭（不确定就不选）<select id="record-duck"><option value="">未关联</option>${data.ducks.map(d=>`<option value="${esc(d.id)}" ${r.duckId===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><div class="record-original">${(r.turns||[]).map(t=>`<strong>${t.role==='child'?'孩子':'鸭鸭'}</strong>：${esc(t.text)}`).join('\n\n')||'这条旧记录没有保留对话原文。'}</div><p id="review-error" class="error" role="alert"></p><div class="dialog-actions"><button type="button" class="button" id="cancel-review">取消</button><button class="button primary" type="submit">保存并标记已核对</button></div></form>`);
  $('#close-dialog').onclick=closeDialog;$('#cancel-review').onclick=closeDialog;
  let attempt;
  $('#review-form').onsubmit=async e=>{
    e.preventDefault();if(persisting)return;
    const text=$('#review-text').value.trim(),duckId=$('#record-duck').value||null;
    if(!text){$('#review-error').textContent='请保留一段记录内容。';return;}
    // Keep the same logical submission when its response was lost or timed out.
    const signature=JSON.stringify([text,duckId]);
    if(attempt?.signature!==signature)attempt={signature,reviewedAt:new Date().toISOString()};
    const next=records().map(item=>item.id===id?{...item,text,duckId,reviewedAt:attempt.reviewedAt}:item);
    persisting=true;const form=e.target;form.inert=true;$('#review-error').textContent='正在保存，请稍等。';
    let saved=false;
    try{await write(RECORDS_KEY,next);saved=true;}
    catch(error){$('#review-error').textContent=error.message||'没有保存成功，请先复制修改后的内容。';}
    finally{persisting=false;form.inert=false;}
    if(saved){closeDialog(true);render();notify('记录已保存，并标记为已核对。');}
    else form.querySelector('[type="submit"]').focus();
  };
}
document.querySelectorAll('nav a,.brand,#child-entry').forEach(a=>a.addEventListener('click',e=>{if(dirty){e.preventDefault();const href=a.getAttribute('href');confirmDiscard(()=>location.href=href);}}));
window.addEventListener('hashchange',()=>{search='';showArchived=false;if(dirty){const desired=location.hash;history.replaceState(null,'',`#${view}`);confirmDiscard(()=>{loadDay(selectedDate);location.hash=desired;});return;}loadDay(selectedDate);render();});
window.addEventListener('beforeunload',e=>{if(dirty||persisting||editorDirty()){e.preventDefault();e.returnValue='';}});
window.addEventListener('storage',e=>{if([STORE_KEY,RECORDS_KEY,DRAFT_KEY].includes(e.key)&&!dirty&&!$('#editor-dialog').open){data=loadData();loadDay(selectedDate);render();}});
$('#editor-dialog').addEventListener('cancel',event=>{event.preventDefault();if(!persisting)closeDialog();});
narrowSchedule.addEventListener('change',()=>{if(view==='schedule'&&!$('#editor-dialog').open){dayDrawerOpen=dirty;render();}});
document.addEventListener('click',e=>{const menu=$('#reuse-menu');if(menu?.open&&!menu.contains(e.target))menu.open=false;});
render();

window.addEventListener('focus',async()=>{
  const refreshView=view,refreshDate=selectedDate;
  const canApply=()=>!dirty&&!persisting&&!$('#editor-dialog').open&&view===refreshView&&selectedDate===refreshDate;
  if(!canApply())return;
  try{if(!await refresh(canApply)||!canApply())return;data=loadData();loadDay(selectedDate);render();}
  catch{notify('尚未连上本机服务，页面显示上次资料。');}
});
