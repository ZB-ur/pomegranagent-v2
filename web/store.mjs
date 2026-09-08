// Shared SQLite-backed state; no browser localStorage or automatic demo seed.
export const STORE_KEY = 'penegranagent-v2:prototype:management';
export const RECORDS_KEY = 'penegranagent-v2:prototype:records';
export const DRAFT_KEY = 'penegranagent-v2:prototype:child-drafts';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export const asDate = value => new Date(`${value}T12:00:00`);
export function shiftDay(value, delta) { const d = asDate(value); d.setDate(d.getDate()+delta); return dateKey(d); }
export let state;
export async function api(path, body, method='POST') {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),['chat','summary'].includes(path)?90000:15000);
  try {
  const response = await fetch('/api/'+path, {signal:controller.signal, method, headers:body===undefined?{}:{'Content-Type':'application/json'}, body:body===undefined?undefined:JSON.stringify(body)});
  if (!response.ok) {
    let detail; try { detail=await response.json(); } catch {}
    const error=new Error(detail?.error || detail?.message || `请求失败 (${response.status})`);
    error.status=response.status; throw error;
  }
  return await response.json();
  } catch(error) {
    if(error.name==='AbortError')throw new Error('等待服务太久了。当前内容还在，请检查本机服务后重试。');
    if(error instanceof TypeError)throw new Error('暂时连不上本机服务。当前内容还在，请启动服务后重试。');
    throw error;
  } finally {clearTimeout(timer);}
}
let tail=Promise.resolve();
function enqueue(work) {
  const operation=tail.then(work);tail=operation.catch(()=>{});return operation;
}
// Refresh and writes share a queue. A background refresh may be abandoned if
// an editor opened while its request was in flight, without changing its base.
export function refresh(canApply=()=>true) {
  return enqueue(async()=>{
    const latest=await api('state',undefined,'GET');
    if(!canApply())return null;
    state=latest;return state;
  });
}
try { await refresh(); } catch { document.body.innerHTML='<main style="padding:60px"><h1>还没有连上本机日记服务</h1><p>请老师启动应用后刷新。已有资料不会被清除。</p><button onclick="location.reload()">重新连接</button></main>'; throw new Error('本机服务不可用'); }
// Never expose the merge base to a caller that keeps and edits its own cache.
export function read(key,fallback) { return structuredClone(({[STORE_KEY]:state.data,[RECORDS_KEY]:state.records,[DRAFT_KEY]:state.drafts})[key] ?? fallback); }
export function loadData() { return structuredClone(state.data); }
const same=(a,b)=>{
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function conflict() { const error=new Error('另一页面也修改了这份内容。当前编辑仍保留，请先复制需要保留的文字，再重新打开核对；本次没有覆盖资料。');error.status=409;return error; }
function merge(base,local,remote,path=[]) {
  if(same(local,base))return structuredClone(remote);
  if(same(remote,base)||same(local,remote))return structuredClone(local);
  // A child's in-progress conversation is indivisible: never splice two
  // independently edited conversations or attach one window's reply to another.
  if(path[0]==='drafts'&&path.length===2)throw conflict();
  if(object(base)&&object(local)&&object(remote)) {
    const result=Object.create(null);
    for(const key of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])) {
      if(path.length===0&&key==='revision'){result[key]=remote[key];continue;}
      const value=merge(base[key],local[key],remote[key],[...path,key]);
      if(value!==undefined)result[key]=value;
    }
    return result;
  }
  // Identity lists can accept independent additions/edits. Ordered transcript
  // and schedule arrays remain atomic, so competing edits require a decision.
  const identityList=path.join('.')==='records'||['data.children','data.ducks'].includes(path.join('.'));
  if(identityList&&[base,local,remote].every(Array.isArray)) {
    const maps=[base,local,remote].map(items=>new Map(items.map(item=>[item.id,item])));
    const ids=[...new Set([...local.map(item=>item.id),...remote.map(item=>item.id),...base.map(item=>item.id)])];
    return ids.map(id=>merge(maps[0].get(id),maps[1].get(id),maps[2].get(id),[...path,id])).filter(value=>value!==undefined);
  }
  throw conflict();
}
let pendingUpdates=0,projected;
export function update(mutator) {
  // Capture intent before joining the queue; queued writes cannot silently
  // adopt a newer revision while carrying an older form's entire snapshot.
  const base=structuredClone(pendingUpdates?projected:state),local=structuredClone(base);mutator(local);
  projected=local;pendingUpdates++;
  return enqueue(async()=>{
    let next=merge(base,local,state);
    for(let attempt=0;attempt<3;attempt++) {
      try {state=await api('state',next,'PUT');return state;}
      catch(error) {
        if(error.status!==409||attempt===2)throw error;
        const latest=await api('state',undefined,'GET');
        // A 409 without a changed revision is an invariant rejection, not a
        // stale version. Never bypass it by retrying or replacing the base.
        if(latest.revision===next.revision)throw error;
        next=merge(base,local,latest);
      }
    }
  }).finally(()=>{pendingUpdates--;if(!pendingUpdates)projected=undefined;});
}
export async function saveData(data) { await update(next=>{next.data=data;}); }
export async function write(key,value) { await update(next=>{if(key===RECORDS_KEY)next.records=value;else if(key===DRAFT_KEY)next.drafts=value;else next.data=value;}); }
export function rosterFor(data,date) { return (data.schedules[date] ?? []).map(id=>data.children.find(c=>c.id===id && c.active)).filter(Boolean); }
export function personAvatar(person, className='') {
  if (person.photo) return `<img class="person-avatar ${className}" src="${escape(person.photo)}" alt="">`;
  if (person.avatar == null) return `<span class="person-avatar placeholder ${className}" aria-hidden="true">${escape(person.name?.slice(-1)||"＋")}</span>`;
  return `<span class="person-avatar avatar-${Number(person.avatar)||0} ${className}" aria-hidden="true"></span>`;
}
export function recordDate(record) { return record.activityDate ?? dateKey(new Date(record.createdAt)); }
