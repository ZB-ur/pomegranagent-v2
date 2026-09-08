// Remove only obvious legacy role cues from duck speech. Never apply to child
// words or diary reading; quoted/embedded imitations of a duck remain intact.
export function duckLine(text) {
  return String(text).replace(/(“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|‘[^’]*’)|(^|[。！？!?\n])\s*嘎{1,2}(?:[。！？!?]\s*|[，,、]\s*)|[，,、]\s*嘎{1,2}(?=[。！？!?\n]|$)/g,
    (_match, quoted, leading) => quoted || leading || '').trim();
}
export function chooseDuckCall() { return Math.random() < .35 ? (Math.random() < .5 ? 'prefix' : 'suffix') : null; }
