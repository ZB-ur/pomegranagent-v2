// Hosts decorate a shared class diary; animal profiles remain independent.
export const DIARY_THEMES = [
  {id:'duck',callDirectory:'/assets/duck-call',navigationScale:1,navigationOffset:'0%',name:'鸭鸭日记',hostName:'鸭鸭',animalName:'小鸭',navigation:'assets/diary-themes/duck-navigation-D2.png',animalDefault:'',description:'暖黄色的小本子，听你慢慢说'},
  {id:'budgerigar',callDirectory:'/assets/animal-call/budgerigar',navigationScale:1.28,navigationOffset:'-4.3%',name:'鹦鹉日记',hostName:'鹦鹉',animalName:'虎皮鹦鹉',navigation:'assets/diary-themes/budgerigar/navigation.png',animalDefault:'assets/diary-themes/budgerigar/animal-default.png',description:'清新的绿叶，收藏小小发现'},
  {id:'hamster',callDirectory:'/assets/animal-call/hamster',navigationScale:1.29,navigationOffset:'-4.4%',name:'仓鼠日记',hostName:'仓鼠',animalName:'金丝熊',navigation:'assets/diary-themes/hamster/navigation.png',animalDefault:'assets/diary-themes/hamster/animal-default.png',description:'温暖的小伙伴，陪你聊照顾的故事'},
];
export const getDiaryTheme = id => DIARY_THEMES.find(theme=>theme.id===id) || DIARY_THEMES[0];
export const themePose = (id,pose) => `assets/diary-themes/${getDiaryTheme(id).id}/${pose}.png`;

// Match the duck silhouette, excluding transparent canvas; feet sit at 90% of its stage.
const poseHeights = {"budgerigar":{"idle":417,"listening":410,"speaking":412,"happy":401,"acknowledging":395,"writing":401,"inviting":394},"hamster":{"idle":382,"listening":378,"speaking":381,"happy":376,"acknowledging":387,"writing":383,"inviting":380}};
export const themePoseWidth = (id,pose) => `${(103 * 512 / poseHeights[id][pose]).toFixed(2)}%`;
export const navigationStyle = theme => `scale:${theme.navigationScale};translate:0 ${theme.navigationOffset}`;

export function applyTeacherTheme(id){
  const theme=getDiaryTheme(id);document.body.dataset.theme=theme.id;
  document.querySelectorAll('[data-diary-name]').forEach(el=>el.textContent=theme.name);
  document.querySelectorAll('[data-theme-navigation]').forEach(el=>{el.src=theme.navigation;el.style.cssText=navigationStyle(theme);});
  document.title=theme.name+' · '+(document.body.classList.contains('settings-body')?'日记本设置':'教师工作台');
  return theme;
}
