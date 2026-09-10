import {match} from './vendor/pinyin-pro/core/match/index.mjs';

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

// Keep full name and nickname separate so a match cannot span two unrelated names.
export function matchesChildName(child, query) {
  const needle = normalize(query);
  if (!needle) return true;
  // A numeric query is an exact student number, avoiding 1 also matching 10/21.
  if (/^\d+$/u.test(needle)) return Number.isSafeInteger(child.studentNumber) && child.studentNumber === Number(needle);
  return [child.name, child.fullName].some(value => {
    const name = normalize(value);
    return name && (name.includes(needle) || match(name, needle, {
      precision: 'first', lastPrecision: 'first', continuous: true, v: true,
    }) !== null);
  });
}
