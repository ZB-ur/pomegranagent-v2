import { getDiaryTheme } from './diary-themes.mjs';
// Real audio only. Session ownership fences late permissions, recording and network callbacks.
export const handlesSpace = e => e.code === 'Space' && !e.repeat && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.target.closest?.('input,textarea,select,[contenteditable="true"]');
let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('duck-diary-audio-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('segments');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('这台浏览器暂时无法保留录音，请老师检查存储空间。'));
  });
  return database;
}
async function audioStore(action, key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('segments', action === 'get' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('segments');
    const request = action === 'put' ? store.put(value, key) : store[action](key);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(new Error('录音还没保存好，请老师检查这台电脑的存储空间。'));
  });
}
function segment(value) {
  return value instanceof Blob ? {id: crypto.randomUUID(), blob: value} : value;
}
async function responseError(response, fallback) {
  try { return new Error((await response.json()).error || fallback); } catch { return new Error(fallback); }
}
// Delete only the segment that was committed; a newer recording must survive.
async function deleteSegment(key, id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('segments', 'readwrite'), store = tx.objectStore('segments');
    const request = store.get(key);
    request.onsuccess = () => { if (request.result?.id === id) store.delete(key); };
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(new Error('录音清理还没完成，已识别的话仍然保留，可以重试。'));
  });
}
export class Recorder {
  constructor({onState, onCommit, onReady, onError}) {
    Object.assign(this, {onState, onCommit, onReady, onError});
    this.session = null;
  }
  owns(session) { return this.session === session && !session.cancelled; }
  setState(session, state) { if (this.owns(session)) this.onState(state); }
  async lock(session) {
    if (!navigator.locks) throw new Error('请老师用支持录音保护的 Chrome 或 Edge 打开。');
    await new Promise((resolve, reject) => {
      navigator.locks.request('duck-diary-audio:' + session.key, {ifAvailable: true}, async lock => {
        if (!lock) { reject(new Error('另一个页面正在处理这段故事，请先在那个页面完成，再回来重试。')); return; }
        await new Promise(release => { session.releaseLock = release; resolve(); });
      }).catch(reject);
    });
  }
  release(session) {
    session.releaseLock?.(); session.releaseLock = null;
    if (this.session === session) this.session = null;
  }
  persist(session, data) {
    const save = session.saving.then(() => audioStore('put', session.key, data));
    session.saving = save.catch(() => {});
    return save;
  }
  async start(key) {
    if (this.session) return;
    const session = this.session = {key, id: crypto.randomUUID(), chunks: [], saving: Promise.resolve(), cancelled: false, submit: false};
    this.setState(session, 'starting');
    try {
      await openDatabase(); await this.lock(session);
      if (!this.owns(session)) { this.release(session); return; }
      if (await audioStore('get', key)) throw new Error('还有一段声音没有记好，请先重新听这段，或选择重新说。');
      if (!this.owns(session)) return;
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('这个浏览器还不能录音，请老师用 Chrome 或 Edge 打开。');
      session.permissionTimer = setTimeout(() => this.fail(session, new Error('麦克风还没有打开，请老师检查浏览器的录音权限，再试一次。')), 20000);
      const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: false});
      clearTimeout(session.permissionTimer); session.stream = stream;
      if (!this.owns(session)) { stream.getTracks().forEach(track => track.stop()); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find(value => MediaRecorder.isTypeSupported(value));
      const recorder = session.recorder = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined);
      recorder.ondataavailable = event => { if (event.data.size) session.chunks.push(event.data); };
      recorder.onerror = () => this.fail(session, new Error('录音遇到问题，已收到的声音会保留。请老师检查麦克风。'));
      recorder.onstop = async () => {
        clearInterval(session.timer);
        stream.getTracks().forEach(track => track.stop());
        const data = {id: session.id, blob: new Blob(session.chunks, {type: recorder.mimeType})};
        let saveError;
        try { if (data.blob.size) await this.persist(session, data); }
        catch (error) { saveError = error; session.saveError = error; }
        finally { session.resolveStopped?.(); }
        // fail/cancel owns cleanup while waiting for this final write.
        if (!this.owns(session)) return;
        if (saveError) { await this.fail(session, saveError); return; }
        if (!session.submit) { await this.fail(session, new Error('麦克风中断了，已收到的声音先留着。请老师检查后重新听这段。')); return; }
        try {
          if (!data.blob.size) throw new Error('没有收到声音，请按空格再说一次。');
          await this.transcribe(session, data);
        } catch (error) { await this.fail(session, error); }
      };
      // The caller stops guidance before opening the microphone. Signal actual readiness with a short tone only.
      recorder.start(1000);
      session.stopped = new Promise(resolve => { session.resolveStopped = resolve; });
      this.setState(session, 'listening');
      session.timer = setInterval(() => {
        if (!this.owns(session) || recorder.state !== 'recording' || !session.chunks.length) return;
        this.persist(session, {id: session.id, blob: new Blob(session.chunks, {type: recorder.mimeType})})
          .catch(error => this.fail(session, error));
      }, 4000);
      this.readyTone();
    } catch (error) { await this.fail(session, error); }
  }
  async readyTone() {
    let context;
    try {
      context = new AudioContext(); await context.resume();
      const tone = context.createOscillator(), gain = context.createGain();
      gain.gain.value = .07; tone.frequency.value = 660; tone.connect(gain); gain.connect(context.destination);
      tone.start(); tone.stop(context.currentTime + .12); tone.onended = () => context.close();
    } catch { context?.close().catch(() => {}); }
  }
  stop() {
    const session = this.session;
    if (!session || session.cancelled || session.recorder?.state !== 'recording') return;
    session.submit = true; clearInterval(session.timer);
    session.recorder.stop(); session.stream.getTracks().forEach(track => track.stop());
    this.setState(session, 'stopping');
  }
  async retry(key) {
    if (this.session) return;
    const session = this.session = {key, saving: Promise.resolve(), cancelled: false};
    this.setState(session, 'stopping');
    try {
      await this.lock(session);
      if (!this.owns(session)) { this.release(session); return; }
      const data = segment(await audioStore('get', key));
      if (!data) throw new Error('没有待识别录音，请按空格重新说。');
      if (this.owns(session)) await this.transcribe(session, data);
    } catch (error) { await this.fail(session, error); }
  }
  async setAside(key) {
    if (this.session) return false;
    const session = this.session = {key, saving: Promise.resolve(), cancelled: false};
    try {
      await this.lock(session);
      if (!this.owns(session)) return false;
      // Track this whole operation so cancellation does not release its lock mid-write.
      const operation = (async () => {
        const data = segment(await audioStore('get', key));
        if (data) {
          await audioStore('put', key + ':previous', data);
          await audioStore('put', key, data);
          await deleteSegment(key, data.id);
        }
      })();
      session.saving = operation.catch(() => {});
      await operation;
      return this.owns(session);
    } finally { this.release(session); }
  }
  async migratePending(oldKey, newKey) {
    if (!navigator.locks) return;
    await navigator.locks.request('duck-diary-audio:' + newKey, {ifAvailable: true}, async lock => {
      if (!lock) return;
      const old = await audioStore('get', oldKey);
      if (!old || await audioStore('get', newKey)) return;
      await audioStore('put', newKey, segment(old));
      await audioStore('delete', oldKey);
    });
  }
  async hasPending(key) { return Boolean(await audioStore('get', key)); }
  async transcribe(session, data) {
    if (!this.owns(session)) return;
    this.setState(session, 'stopping');
    if (!data.text) {
      session.controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; session.controller.abort(); }, 90000);
      try {
        // Retry transport failures only, using the same audio and deadline.
        // An empty or incorrect recognition is not improved by decoding it twice.
        for (let attempt = 0; attempt < 2; attempt++) {
          let response;
          try {
            response = await fetch('/api/transcribe', {method: 'POST', headers: {'Content-Type': data.blob.type}, body: data.blob, signal: session.controller.signal});
          } catch (error) {
            if (attempt === 0 && error instanceof TypeError && this.owns(session) && !session.controller.signal.aborted) continue;
            throw error;
          }
          if (attempt === 0 && [502, 504].includes(response.status) && this.owns(session) && !session.controller.signal.aborted) {
            await response.body?.cancel();
            continue;
          }
          if (!response.ok) throw await responseError(response, '暂时没有听清，录音保留了，请老师检查后重试。');
          data.text = (await response.json()).text?.trim();
          break;
        }
      } catch (error) {
        if (timedOut) throw new Error('识别等待太久了，录音还在。请老师检查本机服务，再重新听这段。');
        throw error;
      } finally { clearTimeout(timer); }
      if (!this.owns(session)) return;
      if (!data.text) throw new Error('没有听清这句话，录音保留了，可以重试或重新说。');
      await this.persist(session, data);
    } else {
      // Normalize legacy Blob records before conditional deletion.
      await this.persist(session, data);
    }
    if (!this.owns(session)) return;
    await this.onCommit(data.text, data.id);
    if (!this.owns(session)) return;
    await deleteSegment(session.key, data.id);
    this.setState(session, 'idle'); this.release(session);
    await this.onReady?.();
  }
  async fail(session, error) {
    if (!this.owns(session)) return;
    clearTimeout(session.permissionTimer); session.submit = false; session.cancelled = true;
    session.controller?.abort(); clearInterval(session.timer);
    if (session.recorder?.state === 'recording') session.recorder.stop();
    session.stream?.getTracks().forEach(track => track.stop());
    // Hold session and its cross-window lock until final onstop persistence settles.
    if (session.stopped) await session.stopped;
    await session.saving;
    if (this.session !== session) { this.release(session); return; }
    this.release(session);
    if (session.silent) return;
    this.onState('idle');
    const problem = session.saveError || error;
    this.onError(problem.name === 'NotAllowedError' ? '麦克风还没有打开，请老师帮忙允许录音。' : problem.message);
  }
  async cancel() {
    const session = this.session;
    if (!session) return;
    clearTimeout(session.permissionTimer); session.cancelled = true; session.silent = true; session.submit = false;
    session.controller?.abort(); clearInterval(session.timer);
    if (session.recorder?.state === 'recording') session.recorder.stop();
    session.stream?.getTracks().forEach(track => track.stop());
    if (session.stopped) await session.stopped;
    await session.saving;
    this.release(session);
  }
}
// One short, bundled acknowledgement per wait; it never asks the speech model
// to do extra work. finish() lets the current clip end before the real reply.
export class ThinkingAudio {
  constructor(onState) { this.onState=onState; this.epoch=0; this.last=-1; this.done=Promise.resolve(); }
  begin(canPlay=()=>true) {
    if(this.active)return;
    this.active=true;const epoch=++this.epoch;
    this.timer=setTimeout(()=>{
      if(!this.active||epoch!==this.epoch||!canPlay())return;
      const choices=Array.from({length:10},(_,index)=>index).filter(index=>index!==this.last);
      const index=choices[Math.floor(Math.random()*choices.length)];this.last=index;
      const audio=this.audio=new Audio(`/assets/voice/qwen-girl-curious/thinking-${String(index+1).padStart(2,'0')}.wav`);
      this.done=new Promise(resolve=>{this.resolve=resolve;});
      const settle=()=>{
        if(epoch!==this.epoch)return;
        clearTimeout(this.guard);audio.pause();audio.onplaying=audio.onended=audio.onerror=null;
        if(this.audio===audio)this.audio=null;
        this.onState(false);this.resolve?.();this.resolve=null;
      };
      // A missing or stalled optional clip must not hold up the real reply.
      this.guard=setTimeout(settle,3000);
      audio.onplaying=()=>{
        if(epoch!==this.epoch){audio.pause();return;}
        clearTimeout(this.guard);this.guard=setTimeout(settle,8000);this.onState(true);
        console.debug('[voice] thinking '+JSON.stringify({candidate:index+1}));
      };
      audio.onended=settle;audio.onerror=settle;
      audio.play().catch(settle);
    },800);
  }
  async finish() {
    const epoch=this.epoch;clearTimeout(this.timer);
    await this.done;
    if(epoch===this.epoch)this.stop();
  }
  stop() {
    ++this.epoch;clearTimeout(this.timer);clearTimeout(this.guard);this.active=false;
    if(this.audio){this.audio.pause();this.audio.onplaying=this.audio.onended=this.audio.onerror=null;this.audio=null;}
    this.resolve?.();this.resolve=null;this.done=Promise.resolve();this.onState(false);
  }
}

export class Speaker {
  constructor(onState, onError) { Object.assign(this, {onState, onError}); this.epoch=0; this.cache=new Map(); this.cacheBytes=0; }
  stop() {
    this.epoch++;this.controller?.abort();this.controller=null;
    if(this.audio){this.audio.pause();this.audio.onended=this.audio.onerror=this.audio.onplaying=null;this.audio=null;}
    this.releaseTransient();this.onState(false);
  }
  clearCache() { this.stop();this.dropCache(); }
  releaseTransient() { if(this.transientUrl){URL.revokeObjectURL(this.transientUrl);this.transientUrl=null;} }
  dropCache() { for(const item of this.cache.values())URL.revokeObjectURL(item.url);this.cache.clear();this.cacheBytes=0; }
  async refreshSettings(signal) {
    const controller=new AbortController(),abort=()=>controller.abort();
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort();
    const timer=setTimeout(abort,10000);
    try {
      const response=await fetch('/api/settings',{signal:controller.signal});
      if(!response.ok)throw await responseError(response,'还没读到声音设置，请重试。');
      const value=await response.json(),key=JSON.stringify([value.voice,value.speechRate,this.themeId]);
      if(signal.aborted)throw new DOMException('Stopped','AbortError');
      if(this.settingsKey!==key){this.dropCache();this.settingsKey=key;}
    } catch(error) {
      if(!signal.aborted&&error.name==='AbortError')throw new Error('读取声音设置等待太久，请重试。');
      throw error;
    } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  async prepare(text,signal) {
    if(signal.aborted)throw new DOMException('Stopped','AbortError');
    if(this.cache.has(text))return this.cache.get(text).url;
    const controller=new AbortController(),requestId=crypto.randomUUID();
    let timedOut=false,completed=false,cancelSent=false;
    const abort=()=>{
      controller.abort();
      if(completed||cancelSent)return;
      cancelSent=true;
      // The request id also fences a cancel that reaches the local server first.
      fetch('/api/speech/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId}),keepalive:true,signal:AbortSignal.timeout(5000)}).catch(()=>{});
    };
    signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;abort();},180000);
    try {
      const response=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,themeId:this.themeId,requestId}),signal:controller.signal});
      if(!response.ok)throw await responseError(response,'语音引导还没准备好，请老师检查本机语音后，点聊天小伙伴重听。');
      const blob=await response.blob();completed=true;
      if(signal.aborted)throw new DOMException('Stopped','AbortError');
      const url=URL.createObjectURL(blob);
      const limit=32*1024*1024;
      if(blob.size>limit){this.transientUrl=url;return url;}
      while(this.cache.size&&(this.cache.size>=40||this.cacheBytes+blob.size>limit)){
        const [key,old]=this.cache.entries().next().value;URL.revokeObjectURL(old.url);this.cacheBytes-=old.size;this.cache.delete(key);
      }
      this.cache.set(text,{url,size:blob.size});this.cacheBytes+=blob.size;return url;
    } catch(error) {
      if(timedOut)throw new Error('准备声音等待太久了，请老师检查本机服务，再点聊天小伙伴重听。');
      throw error;
    } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  async speak(text,onDone,playback={}) {
    this.stop();const epoch=this.epoch,controller=this.controller=new AbortController();
    const current=()=>epoch===this.epoch&&!controller.signal.aborted;
    const requestedAt=performance.now(),value=String(text).trim(),callDirectory=getDiaryTheme(this.themeId).callDirectory;
    let finished=false,firstAudio=true;
    const fail=error=>{
      if(!current()||finished||error.name==='AbortError')return;
      finished=true;controller.abort();this.audio?.pause();this.audio=null;this.releaseTransient();this.onState(false);playback.onError?.();
      this.onError(error.name==='NotAllowedError'?'点一下聊天小伙伴，开启声音引导。':error.message);
    };
    const playFile=(url,cue=false)=>new Promise((resolve,reject)=>{
      if(!current()){resolve();return;}
      const audio=this.audio=new Audio(url);let started=false,timer;
      const clean=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);audio.onended=audio.onerror=audio.onplaying=null;if(this.audio===audio)this.audio=null;};
      const abort=()=>{audio.pause();clean();reject(new DOMException('Stopped','AbortError'));};
      controller.signal.addEventListener('abort',abort,{once:true});
      audio.onplaying=()=>{
        if(!current()||started)return;
        started=true;clearTimeout(timer);
        console.debug('[voice] playback '+JSON.stringify({wholeReply:!cue,cue:cue||undefined,firstAudioMs:firstAudio?Math.round(performance.now()-requestedAt):undefined}));
        firstAudio=false;this.onState(true);if(cue)playback.onCue?.();else playback.onChunk?.(value);
      };
      audio.onended=()=>{clean();resolve();};
      audio.onerror=()=>{audio.pause();clean();reject(new Error('声音没有播出来，请老师检查扬声器，再点聊天小伙伴重听。'));};
      timer=setTimeout(()=>{audio.pause();clean();reject(new Error('浏览器还没有开始播放，请老师打开这个页面，再点聊天小伙伴重听。'));},15000);
      audio.play().catch(error=>{clean();reject(error);});
    });
    try {
      if(!value){finished=true;onDone?.();return;}
      this.onState(false,{phase:'preparing'});playback.onPreparing?.();
      await this.refreshSettings(controller.signal);
      // The full utterance is synthesized once. No sentence splitting, lookahead
      // requests or background generation compete with the child's reply.
      const url=await this.prepare(value,controller.signal);
      if(!current())return;
      await playback.beforePlay?.(controller.signal);
      if(!current())return;
      if(playback.duckCall==='prefix')await playFile(callDirectory+'/prefix.wav','prefix');
      if(!current())return;
      await playFile(url);
      if(!current())return;
      if(playback.duckCall==='suffix')await playFile(callDirectory+'/suffix.wav','suffix');
      if(!current())return;
      finished=true;this.controller=null;this.releaseTransient();this.onState(false);onDone?.();
    } catch(error){fail(error);}
  }
}
