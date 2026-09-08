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
      // The voiced start cue has finished. The short readiness tone contains no speech.
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
        const response = await fetch('/api/transcribe', {method: 'POST', headers: {'Content-Type': data.blob.type}, body: data.blob, signal: session.controller.signal});
        if (!response.ok) throw await responseError(response, '暂时没有听清，录音保留了，请老师检查后重试。');
        data.text = (await response.json()).text?.trim();
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
export class Speaker {
  constructor(onState, onError) { Object.assign(this, {onState, onError}); this.epoch = 0; this.cache = new Map(); }
  stop() {
    this.epoch++; this.controller?.abort(); this.warmController?.abort();
    if (this.audio) { this.audio.pause(); this.audio.onended = this.audio.onerror = this.audio.onplaying = null; this.audio = null; }
    this.onState(false);
  }
  clearCache() { this.stop(); this.dropCache(); }
  dropCache() { for (const url of this.cache.values()) URL.revokeObjectURL(url); this.cache.clear(); }
  async refreshSettings(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 10000);
    try {
      const response = await fetch('/api/settings', {signal:controller.signal});
      if (!response.ok) throw await responseError(response, '还没读到声音设置，请重试。');
      const value = await response.json();
      const key = JSON.stringify([value.voice, value.speechRate]);
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      if (this.settingsKey !== key) { this.dropCache(); this.settingsKey = key; }
    } catch (error) {
      if (!signal.aborted && error.name === 'AbortError') throw new Error('读取声音设置等待太久，请重试。');
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async prepare(text, signal) {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    if (this.cache.has(text)) return this.cache.get(text);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, {once:true});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
    try {
      const response = await fetch('/api/speech', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}), signal:controller.signal});
      if (!response.ok) throw await responseError(response, '语音引导还没准备好，请老师检查本机语音后，点鸭鸭重听。');
      const blob = await response.blob();
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const url = URL.createObjectURL(blob);
      if (this.cache.size >= 40) { const [key, old] = this.cache.entries().next().value; URL.revokeObjectURL(old); this.cache.delete(key); }
      this.cache.set(text, url);
      return url;
    } catch (error) {
      if (timedOut) throw new Error('准备声音等待太久了，请老师检查本机服务，再点鸭鸭重听。');
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async preload(texts) {
    this.warmController?.abort();
    const controller = this.warmController = new AbortController();
    try {
      await this.refreshSettings(controller.signal);
      for (const text of texts) await this.prepare(text, controller.signal);
    } catch { /* Optional idle warming must never replace an actionable voice error. */ }
  }
  async speak(text, onDone, playback = {}) {
    this.stop(); const epoch = this.epoch; const controller = this.controller = new AbortController();
    const current = () => epoch === this.epoch && !controller.signal.aborted;
    const requestedAt = performance.now();
    let previousEndedAt = null;
    const chunks = [];
    for (const sentence of String(text).match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g) || []) {
      for (let offset = 0; offset < sentence.length; offset += 240) chunks.push({text:sentence.slice(offset, offset + 240)});
    }
    // A call is an audio-only part of the same owned playback queue. Never send
    // it to TTS or expose it as a child's words. End cues remain after the reply.
    if (['prefix','suffix'].includes(playback.duckCall) && chunks.length) {
      let boundary=0, length=0;
      while(boundary<chunks.length && length<String(playback.duckCallText || text).length) length+=chunks[boundary++].text.length;
      chunks.splice(playback.duckCall==='prefix'?0:boundary,0,{cue:playback.duckCall});
    }
    const fail = error => {
      if (!current() || error.name === 'AbortError') return;
      controller.abort(); this.audio?.pause(); this.onState(false); playback.onError?.();
      this.onError(error.name === 'NotAllowedError' ? '点一下鸭鸭，开启声音引导。' : error.message);
    };
    // Resolve lookahead failures into values so a failed future chunk cannot
    // reject unhandled or interrupt the sentence that is already playing.
    const prepared = new Map();
    const prepare = index => {
      if(prepared.has(index))return prepared.get(index);
      const entry = {ready:false};
      prepared.set(index,entry);
      const chunk=chunks[index];
      const source=chunk.cue ? Promise.resolve('/assets/duck-call/'+chunk.cue+'.wav') : this.prepare(chunk.text, controller.signal);
      entry.promise = source.then(url => {
        const audio = new Audio(url); audio.preload = 'auto'; audio.load();
        entry.ready = true; return {audio};
      }, error => ({error}));
      return entry;
    };
    const play = async (index, entry) => {
      if (!current()) return;
      if (!entry.ready) { this.onState(false, {phase:index ? 'buffering' : 'preparing'}); playback.onPreparing?.(); }
      const result = await entry.promise;
      if (!current()) return;
      if (result.error) { fail(result.error); return; }
      const audio = this.audio = result.audio;
      // Generate the following sentence while this one plays, not after it ends.
      const next = index + 1 < chunks.length ? prepare(index + 1) : null;
      let started = false;
      audio.onplaying = () => {
        if (current() && !started) {
          started = true;
          console.debug('[voice] playback ' + JSON.stringify({chunk:index + 1, cue:chunks[index].cue, firstAudioMs:index === 0 ? Math.round(performance.now() - requestedAt) : undefined, gapMs:previousEndedAt === null ? undefined : Math.round(performance.now() - previousEndedAt)}));
          this.onState(true);
          if(chunks[index].cue)playback.onCue?.();else playback.onChunk?.(chunks[index].text);
        }
      };
      audio.onended = () => {
        if (!current()) return;
        previousEndedAt = performance.now();
        if (next) void play(index + 1, next).catch(fail);
        else { this.audio = null; this.onState(false); onDone?.(); }
      };
      audio.onerror = () => fail(new Error('声音没有播出来，请老师检查扬声器，再点鸭鸭重听。'));
      let timer;
      try {
        await Promise.race([audio.play(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('浏览器还没有开始播放，请老师打开这个页面，再点鸭鸭重听。')), 15000); })]);
      } finally { clearTimeout(timer); }
    };
    try {
      if (!chunks.length) { onDone?.(); return; }
      playback.onPreparing?.();
      await this.refreshSettings(controller.signal);
      // Prepare the first spoken sentence before a prefix call, so the call
      // cannot be followed by a fresh synthesis wait.
      if(current() && chunks[0].cue && chunks[1]) {
        const first=prepare(0), speech=await prepare(1).promise;
        if(speech.error){fail(speech.error);return;}
        if(current())await play(0,first);
        return;
      }
      if (current()) await play(0, prepare(0));
    } catch (error) { fail(error); }
  }
}
