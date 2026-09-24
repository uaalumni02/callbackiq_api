// Resolve references only against one known customer request. This module never
// decides catalog eligibility, urgency, or whether an appointment can be booked.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const actions = 'repair|replace|install|inspect|clean|fix|remove|paint|trim|reseal|recaulk';
const actionWords = /\b(?:needs?|requires?|is|are|was|has|have|won['’]?t|will not|stopped|keeps?|repair|replace|install|inspect|clean|fix|remove|paint|trim|reseal|recaulk|replacement|replaced|installation|installed|removal|cleaning|inspection|maintenance|leaking|clogged|broken|not working)\b/i;
export function serviceSubject(value) {
  let text = clean(value).split(/[:;]/)[0].replace(/^(?:i|we)\s+(?:need|want|would like)\s+/i, '');
  text = text.replace(new RegExp(`^(?:${actions})(?:ing)?\\s+(?:of\\s+)?`, 'i'), '');
  text = text.split(actionWords)[0].replace(/^(?:my|our|the|a|an)\s+/i, '').trim();
  if (!text || /\b(?:and|or|it|this|that|thing|unknown)\b/i.test(text) || text.split(' ').length > 8) return '';
  return text;
}
export function resolveServiceReference(value, previous) {
  const text = clean(value).replace(/^(it|that|this)['’]s\b/i, '$1 is').replace(/^(?:actually|correction|instead|i meant)[,:]?\s*/i, '');
  const known = clean(previous);
  if (/^(?:it['’]s|it is|that is|this is)\s+(?:actually\s+)?(?:the|my|our|a|an)\s+/i.test(text)) return null;
  const subject = serviceSubject(known);
  const action = text.match(new RegExp(`^(?:(?:can|could|would) you |please |(?:i|we) (?:want|need) (?:you to )?)*(${actions}) (?:it|that|this|the same (?:thing|problem)|(?:the|this|that) (?:issue|problem))(?:\\s+(?:instead|please|now|rather))?[?.!]*$`, 'i'));
  if (action) {
    // A question about price does not change the job. An explicit action change does.
    if (!subject || !/\b(?:instead|rather)\b/i.test(text)) return '';
    return `${subject} ${action[1].toLowerCase() === 'fix' ? 'repair' : action[1].toLowerCase()}`;
  }
  const condition = text.match(/^(?:it|that|this)\s+(?:(?:is|has|was)\s+)?(?:actually\s+)?(.+)$/i);
  if (!condition || !subject) return null;
  const detail = condition[1].replace(/[.!?]+$/, '');
  if (!/\b(?:leak(?:ing|s)?|dripp?ing|overflowing|flooding|clogged|blocked|broken|working|stopped|noisy|rattling|stuck|loose|heat|cooling|power)\b/i.test(detail)) return null;
  // Conditions replace conditions in the same family; unrelated facts survive.
  if (/^(?:leaking|dripping|overflowing|clogged|blocked|broken|noisy|rattling|stuck|loose)$/i.test(detail) &&
      known.toLowerCase().includes(detail.toLowerCase()) && !/\b(?:no|not|never|stopped|longer)\b/i.test(known)) return known;
  const family = /leak|drip|overflow|flood/i.test(detail) ? /leak|drip|overflow|flood/i
    : /clog|block/i.test(detail) ? /clog|block/i : /working|stopped|broken|heat|cooling|power|noisy|rattling|stuck|loose/i;
  const clauses = known.replace(/; current condition:/gi, ';').split(/\s*[:;]\s*|\s+(?:but|and)\s+/i).filter(Boolean);
  const original = known.split(/[:;]/)[0];
  const polarityOrTiming = /\b(?:no|not|never|stopped|longer|only|continuously|constantly|now|currently|still)\b/i;
  const kept = [...new Set(clauses.filter(part => !family.test(part) ||
    (original.includes(part) && !polarityOrTiming.test(part) && !/\b(?:no|not|never|stopped|longer)\b/i.test(detail) && part.toLowerCase().includes(subject.toLowerCase()))))];
  if (!kept.some(part => part.toLowerCase().includes(subject.toLowerCase()))) kept.unshift(subject);
  const next = `${kept.join('; ')}; current condition: ${detail}`;
  return next.length <= 200 ? next : `${subject}; current condition: ${detail}`.slice(0, 200);
}
