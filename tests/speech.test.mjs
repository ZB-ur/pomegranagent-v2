import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechInput, handlesSpace } from '../prototype/speech.mjs';

function harness() {
  const sessions = [], commits = [], errors = [], texts = [];
  class Recognition {
    constructor() { sessions.push(this); }
    start() { this.onstart(); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    result(text) { this.onresult({results:[[{transcript:text}]]}); }
  }
  const input = new SpeechInput({Recognition,onState:() => {},onText:t => texts.push(t),onCommit:t => commits.push(t),onError:(e,t) => errors.push({e,t})});
  return {input,sessions,commits,errors,texts};
}

test('thinking pause restarts recognition without submitting; explicit stop joins both sessions', async () => {
  const h = harness(); h.input.start();
  h.sessions[0].result('我换了水。'); h.sessions[0].onend();
  assert.deepEqual(h.commits, []);
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(h.sessions.length, 2);
  h.sessions[1].result('小鸭过来喝了。'); h.input.stop();
  assert.deepEqual(h.commits, []);
  h.sessions[1].onend();
  assert.deepEqual(h.commits, ['我换了水。小鸭过来喝了。']);
});

test('explicit stop waits for the final corrected transcript and submits only once', () => {
  const h = harness(); h.input.start(); const rec = h.sessions[0];
  rec.result('我给小鸭'); h.input.stop(); rec.result('我给小鸭换了水。'); rec.onend(); rec.onend();
  assert.deepEqual(h.commits, ['我给小鸭换了水。']);
});

test('recognition failure preserves captured words for a retry', () => {
  const h = harness(); h.input.start(); h.sessions[0].result('我换了水');
  h.sessions[0].onerror({error:'network'});
  assert.deepEqual(h.errors, [{e:'network',t:'我换了水'}]);
  assert.deepEqual(h.commits, []);
  h.input.start(h.errors[0].t); h.sessions[1].result('然后小鸭喝了。'); h.input.stop(); h.sessions[1].onend();
  assert.deepEqual(h.commits, ['我换了水然后小鸭喝了。']);
});

test('late events from a canceled microphone cannot contaminate a new turn', () => {
  const h = harness(); h.input.start(); const old = h.sessions[0]; h.input.cancel(); h.input.start();
  old.result('旧内容'); old.onend();
  h.sessions[1].result('新内容'); h.input.stop(); h.sessions[1].onend();
  assert.deepEqual(h.commits, ['新内容']);
});

test('Space ignores auto-repeat, composition and text editing; buttons use Enter while Space controls voice', () => {
  const blank = {closest:() => null};
  assert.equal(handlesSpace({code:'Space',target:blank}), true);
  assert.equal(handlesSpace({code:'Space',repeat:true,target:blank}), false);
  assert.equal(handlesSpace({code:'Space',isComposing:true,target:blank}), false);
  assert.equal(handlesSpace({code:'Space',target:{closest:() => ({})}}), false);
  assert.equal(handlesSpace({code:'Space',target:{id:'finish-button',closest:s => s.startsWith('input') ? null : {}}}), true);
  assert.equal(handlesSpace({code:'Space',target:{id:'record-toggle',closest:s => s.startsWith('input') ? null : {}}}), true);
});
