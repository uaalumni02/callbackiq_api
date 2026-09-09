// Match business-configured phrases, not an inferred diagnosis or a price.
export const normalizeServiceText = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/\bbath\s+tub\b/g, 'bathtub')
    .replace(/\ba\s*\/\s*c\b/g, 'ac').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  : '';
const words = value => normalizeServiceText(value).split(' ').filter(Boolean);
export function matchesServicePhrase(value, phrase) {
  const text = normalizeServiceText(value), term = normalizeServiceText(phrase);
  if (!term) return false;
  if (` ${text} `.includes(` ${term} `)) return true;
  const wanted = words(term).filter(word => !['a', 'an', 'the', 'is', 'are', 'my', 'our', 'needs', 'need'].includes(word));
  if (wanted.length < 2) return false;
  const tokens = words(text);
  // "clogged bathtub" also matches "my bathtub is clogged", but not
  // substrings or unrelated words far apart in a long conversation.
  for (let i = 0; i < tokens.length; i += 1) {
    const window = tokens.slice(i, i + Math.max(wanted.length + 3, 6));
    if (wanted.every(word => window.includes(word))) return true;
  }
  return false;
}
