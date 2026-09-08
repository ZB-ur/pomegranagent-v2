import {match} from './vendor/pinyin-pro/core/match/index.mjs';

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

// Keep full name and nickname separate so a match cannot span two unrelated names.
export function matchesChildName(child, query) {
  const needle = normalize(query);
  if (!needle) return true;
  return [child.name, child.fullName].some(value => {
    const name = normalize(value);
    return name && (name.includes(needle) || match(name, needle, {
      precision: 'first', lastPrecision: 'first', continuous: true, v: true,
    }) !== null);
  });
}
