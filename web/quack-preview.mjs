const names = {
  voice: '原句', prefix: '开头鸭叫', suffix: '结尾鸭叫',
  soft: '柔和鸭叫', softer: '更轻鸭叫',
};
const recording = new URLSearchParams(location.search).get('source') === 'original' ? 'original' : 'qubodup';
const recordingSelect = document.querySelector('#recording');
recordingSelect.value = recording;
document.querySelector('#credit-qubodup').hidden = recording !== 'qubodup';
document.querySelector('#credit-original').hidden = recording !== 'original';
document.querySelector('#recording-note').textContent = recording === 'qubodup'
  ? '当前为新素材：保留完整叫声，约 1.13 秒；正文与上一版相同，便于比较。'
  : '当前为上一版：较短的轻叫声，约 0.21 秒；正文保持相同。';
recordingSelect.addEventListener('change', () => {
  stop('');
  const next = new URL(location.href);
  next.searchParams.set('source', recordingSelect.value);
  location.assign(next.href);
});
const player = new Audio();
player.preload = 'auto';
const status = document.querySelector('#status');
const draw = document.querySelector('#draw');
const stopButton = document.querySelector('#stop');
const retryButton = document.querySelector('#retry');
const playButtons = [...document.querySelectorAll('[data-sample], #random-play')];
const urls = new Map();
let ready = false;
let busy = false;
let currentName = '';
let generation = 0;
let loadingController;

function controls() {
  playButtons.forEach(button => { button.disabled = !ready || busy; });
  stopButton.disabled = !busy;
}

function stop(message = '已停止。可以选择另一段试听。') {
  generation += 1;
  player.pause();
  player.removeAttribute('src');
  player.load();
  busy = false;
  controls();
  if (message) status.textContent = message;
}

function release() {
  loadingController?.abort();
  stop('');
  urls.forEach(url => URL.revokeObjectURL(url));
  urls.clear();
  ready = false;
  controls();
}

async function preload() {
  release();
  const operation = generation;
  loadingController = new AbortController();
  const signal = loadingController.signal;
  status.textContent = '正在准备 5 段声音…';
  retryButton.hidden = true;
  const results = await Promise.allSettled(Object.keys(names).map(async key => {
    const folder = recording === 'qubodup' && key !== 'voice' ? 'qubodup/' : '';
    const response = await fetch(`/assets/quack-preview/${folder}${key}.wav`, { signal });
    if (!response.ok) throw new Error('声音暂时无法加载');
    const blob = await response.blob();
    if (!blob.size) throw new Error('声音文件为空');
    return [key, blob];
  }));
  if (operation !== generation || signal.aborted) return;
  if (results.some(result => result.status === 'rejected')) {
    status.textContent = '声音未准备好，请确认本机服务已启动后重试。';
    retryButton.hidden = false;
    return;
  }
  results.forEach(result => urls.set(result.value[0], URL.createObjectURL(result.value[1])));
  ready = true;
  controls();
  status.textContent = '声音已准备好，选一段听听。';
}

async function play(key, random = false) {
  if (!ready || busy) return;
  const operation = ++generation;
  currentName = names[key];
  busy = true;
  controls();
  draw.textContent = random
    ? `本次抽签：${key === 'voice' ? '不加鸭叫，只说正文' : `${currentName}，一整句仅一次`}。`
    : `本次对比：${currentName}。`;
  status.textContent = `正在准备播放：${currentName}…`;
  player.src = urls.get(key);
  try {
    await player.play();
  } catch {
    if (operation !== generation) return;
    stop('这段声音未能播放，请再点一次试听。');
  }
}

player.addEventListener('playing', () => {
  if (busy) status.textContent = `正在播放：${currentName}`;
});
player.addEventListener('ended', () => {
  if (busy) stop(`${currentName}播放完毕。可以换一段比较。`);
});
player.addEventListener('error', () => {
  if (busy) stop('这段声音未能播放，请再点一次试听。');
});
document.querySelectorAll('[data-sample]').forEach(button => {
  button.addEventListener('click', () => play(button.dataset.sample));
});
document.querySelector('#random-play').addEventListener('click', () => {
  if (!ready || busy) return;
  const key = Math.random() < 0.35 ? (Math.random() < 0.5 ? 'prefix' : 'suffix') : 'voice';
  play(key, true);
});
stopButton.addEventListener('click', () => stop());
retryButton.addEventListener('click', preload);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && busy) {
    event.preventDefault();
    stop();
  }
  if (event.repeat && ['Enter', ' '].includes(event.key) && event.target instanceof HTMLButtonElement) event.preventDefault();
});
window.addEventListener('pagehide', release);
window.addEventListener('pageshow', event => { if (event.persisted) preload(); });
preload();
