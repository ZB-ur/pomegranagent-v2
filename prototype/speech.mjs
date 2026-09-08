export class SpeechInput {
  constructor({ Recognition, onState, onText, onCommit, onError }) {
    Object.assign(this, { Recognition, onState, onText, onCommit, onError });
    this.state = 'idle'; this.epoch = 0; this.active = false;
  }
  setState(state) { this.state = state; this.onState(state); }
  start(initial = '') {
    if (this.state !== 'idle') return;
    if (!this.Recognition) { this.onError('unsupported', initial); return; }
    this.active = true; this.buffer = initial; this.segment = ''; this.session();
  }
  session() {
    const epoch = ++this.epoch;
    const rec = this.rec = new this.Recognition();
    rec.lang = 'zh-CN'; rec.continuous = true; rec.interimResults = true;
    this.segment = ''; this.setState('starting');
    rec.onstart = () => { if (epoch === this.epoch && this.active) this.setState('listening'); };
    rec.onresult = event => {
      if (epoch !== this.epoch) return;
      this.segment = Array.from(event.results).map(result => result[0].transcript).join('');
      this.onText(this.buffer + this.segment);
    };
    rec.onerror = event => {
      if (epoch !== this.epoch || event.error === 'no-speech') return;
      const text = this.buffer + this.segment;
      this.cancel(); this.onError(event.error, text);
    };
    rec.onend = () => {
      if (epoch !== this.epoch) return;
      this.buffer += this.segment; this.segment = '';
      // A pause ends a browser session, never the child's turn.
      if (this.active) this.restart = setTimeout(() => { if (this.active && epoch === this.epoch) this.session(); }, 250);
      else this.finish();
    };
    try { rec.start(); } catch { this.cancel(); this.onError('start-failed', this.buffer); }
  }
  stop() {
    if (!this.active) return;
    this.active = false; clearTimeout(this.restart); this.setState('stopping');
    this.stopTimer = setTimeout(() => { this.buffer += this.segment; this.segment = ''; this.finish(); }, 2000);
    try { this.rec.stop(); } catch { this.buffer += this.segment; this.segment = ''; this.finish(); }
  }
  finish() {
    clearTimeout(this.stopTimer);
    const text = this.buffer.trim();
    this.epoch++; this.rec?.abort(); this.setState('idle'); this.onCommit(text);
  }
  cancel() {
    this.active = false; this.epoch++; clearTimeout(this.restart); clearTimeout(this.stopTimer);
    this.rec?.abort(); this.setState('idle');
  }
}
export function handlesSpace(event) {
  const target = event.target;
  return event.code === 'Space' && !event.repeat && !event.isComposing &&
    !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
    !target?.closest?.('input, textarea, select, [contenteditable="true"]');
}
