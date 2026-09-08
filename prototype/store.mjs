// Shared local prototype data. All initial people and schedules are fictional.
export const STORE_KEY = 'penegranagent-v2:prototype:management';
export const RECORDS_KEY = 'penegranagent-v2:prototype:records';
export const DRAFT_KEY = 'penegranagent-v2:prototype:child-drafts';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export const asDate = value => new Date(`${value}T12:00:00`);
export function shiftDay(value, delta) { const d = asDate(value); d.setDate(d.getDate()+delta); return dateKey(d); }
export function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export function seedData() {
  const children = [
    {id:'demo-mumu',name:'沐沐',fullName:'林沐沐',avatar:0,note:'',active:true},
    {id:'demo-duoduo',name:'朵朵',fullName:'陈朵朵',avatar:1,note:'',active:true},
    {id:'demo-nuannuan',name:'暖暖',fullName:'李暖暖',avatar:2,note:'',active:true},
    {id:'demo-yangyang',name:'阳阳',fullName:'周阳阳',avatar:3,note:'',active:true},
  ];
  const today = dateKey(), now = new Date(), schedules = {};
  for (let day=1;day<=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();day++) {
    const date = new Date(now.getFullYear(),now.getMonth(),day,12);
    if ([0,6].includes(date.getDay()) || day % 5 === 0) continue;
    schedules[dateKey(date)] = [children[day%4].id,children[(day+1)%4].id];
  }
  schedules[today] = children.slice(0,3).map(c=>c.id);
  return {children,ducks:[
    {id:'duck-xiaohuang',name:'小黄',note:'浅黄色羽毛，喜欢在水盆边散步。',color:'gold',active:true},
    {id:'duck-dabai',name:'大白',note:'白色羽毛，橙色的小嘴。',color:'cream',active:true},
    {id:'duck-doudou',name:'豆豆',note:'头顶有一小撮深色羽毛，很好认。',color:'sage',active:true},
  ],schedules};
}
export function loadData() { return read(STORE_KEY,null) ?? seedData(); }
export function saveData(data) { localStorage.setItem(STORE_KEY,JSON.stringify(data)); }
export function rosterFor(data,date) { return (data.schedules[date] ?? []).map(id=>data.children.find(c=>c.id===id && c.active)).filter(Boolean); }
export function personAvatar(person, className='') {
  if (person.photo) return `<img class="person-avatar ${className}" src="${escape(person.photo)}" alt="">`;
  if (person.avatar == null) return `<span class="person-avatar placeholder ${className}" aria-hidden="true">${escape(person.name?.slice(-1)||"＋")}</span>`;
  return `<span class="person-avatar avatar-${Number(person.avatar)||0} ${className}" aria-hidden="true"></span>`;
}
export function recordDate(record) { return record.activityDate ?? dateKey(new Date(record.createdAt)); }
