// Keep accepted scheduling evidence separate from rejected alternatives. This
// is deliberately deterministic: unclear corrections never authorize a slot.
const DATE = /\b(?:today|tomorrow|tmrw|tmr|tonight|(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day)?|tuesday|wednesday|thursday|saturday|next week|next month|weekend|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const TIME = /\b(?:\d{1,2}(?::\d{2})?\s*[ap]m|\d{1,2}:\d{2}|(?:at|after|before|around)\s+\d{1,2}|morning|afternoon|evening|noon|midnight|after work)\b/i;
const temporal = text => DATE.test(text) || TIME.test(text);
const clean = value => String(value || '').normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

export function schedulingEvidence(value) {
  const original = clean(value);
  // Dots in spoken-clock abbreviations are not sentence boundaries.
  let text = original.replace(/\b([ap])\.\s*m\.?/gi, '$1m');
  // Lower/upper bounds are positive constraints, not rejected clock values.
  text = text.replace(/\bnot before\b/gi, 'after').replace(/\bnot after\b/gi, 'before')
    .replace(/\bno earlier than\b/gi, 'after').replace(/\bno later than\b/gi, 'before');
  const normalized = text;
  const superseded = [];
  const correction = /\b(?:actually|make that|i mean)\b/i.exec(text);
  if (correction && temporal(text.slice(0, correction.index)) && temporal(text.slice(correction.index + correction[0].length))) {
    superseded.push(text.slice(0, correction.index));
    text = text.slice(correction.index + correction[0].length);
  }
  text = text.replace(/\b(?:instead of|rather than)\b/gi, '; not ')
    .replace(/\b(?:but|however|actually)\b/gi, ';');
  // "Friday at ten, not Monday" and "Friday, instead of Monday" agree.
  text = text.replace(/\s+not\s+(?=(?:(?:on|at|this|next)\s+)?(?:today|tomorrow|tonight|tmrw|mon|tue|wed|thu|fri|sat|sun|\d|morning|afternoon|evening|noon|midnight))/gi, (match, offset) => temporal(text.slice(0, offset)) ? '; not ' : match);
  const accepted = [], rejected = [...superseded];
  for (const clause of text.split(/[;!?]|\.(?!\d)|,(?!\s*\d{4}\b)/).map(clean).filter(Boolean)) {
    const negativePrefix = clause.replace(/^(?:(?:and|or)\s+)*(?:no|not|never)\s+(?:(?:on|at|this|next)\s+)?/i, '');
    const negative = (negativePrefix !== clause && (negativePrefix.search(DATE) === 0 || negativePrefix.search(TIME) === 0)) ||
      /\b(?:can't|cannot|can not|couldn't|won't|will not|don't|do not)\s+(?:do|make|come|attend|schedule|book|want|work|be available)\b/i.test(clause) ||
      /\b(?:doesn't|does not|won't|will not|can't|cannot)\s+work\b/i.test(clause) ||
      /\b(?:unavailable|not available|not possible|not good|isn't available|isn't possible|isn't good|doesn't suit|does not suit)\b/i.test(clause);
    if (negative && temporal(clause)) rejected.push(clause);
    else accepted.push(clause);
  }
  // No rejection: preserve the original date/range grammar and punctuation.
  return {
    text: rejected.length ? accepted.join('; ') : normalized,
    rejected,
    rejectedDate: rejected.some(clause => DATE.test(clause)),
    rejectedTime: rejected.some(clause => TIME.test(clause)),
  };
}
