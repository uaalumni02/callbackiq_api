// Questions describe customer intent, never a price, duration, or booking promise.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export const completionClarification = 'Do you mean how long the work would take, when it could be completed, or the estimated cost?';
export function requestQuestions(text, pending = []) {
  const value = clean(text);
  const completion = /\b(?:completion|complete[ds]?|finish(?:ed)?|how long|how much time|how many (?:hours|days)|how soon|duration|take to (?:install|repair|replace))\b/i.test(value);
  const explicitCost = /\b(?:cost|price|pricing|charge|dollars?)\b|\$/i.test(value);
  const ambiguous = completion && /\b(?:how much|estimate[ds]?)\b/i.test(value) && !explicitCost && !/\b(?:hours?|days?|duration|how long|how much time|how soon)\b/i.test(value);
  const clarificationAnswer = pending.some(q => q.kind === 'completion_meaning') && /^(?:(?:i mean|the|estimated)\s+)*(?:cost|price|duration|time|how long|when|both)[.!? ]*$/i.test(value);
  const duration = !ambiguous && (/\b(?:how long|how much time|duration|how many (?:hours|days)|time (?:it |the (?:job|work) )?(?:takes?|will take))\b/i.test(value) || clarificationAnswer && /duration|time|how long|both/i.test(value));
  const completionDate = !ambiguous && (/\bhow soon\b/i.test(value) || /\bwhen\b.{0,60}\b(?:complete|completed|finished|done)\b/i.test(value) || clarificationAnswer && /^when/i.test(value));
  const pricing = explicitCost || (!completion && /\b(?:how much|quote|estimate|fee)\b/i.test(value)) || clarificationAnswer && /cost|price|both/i.test(value);
  return { ambiguous, duration, completionDate, pricing, clarificationAnswer };
}
export function updateRequestQuestions(state, text, turnId = '') {
  const pending = Array.isArray(state.unresolvedQuestions) ? state.unresolvedQuestions : [];
  const intent = requestQuestions(text, pending);
  let next = intent.clarificationAnswer ? pending.filter(q => q.kind !== 'completion_meaning') : [...pending];
  for (const [kind, active] of [['completion_meaning', intent.ambiguous], ['duration', intent.duration], ['completion_date', intent.completionDate], ['price', intent.pricing]]) {
    if (active && !next.some(q => q.kind === kind)) next.push({ kind, text: clean(text).slice(0, 500), turnId: String(turnId), status: 'needs_answer' });
  }
  state.unresolvedQuestions = next.slice(-12);
  return intent;
}
export function normalizeRequestService(value) {
  return clean(value).replace(/^(?:hi|hello|hey)[,!]?\s+/i, '').replace(/^(?:i|we)\s+(?:need|want|would like)\s+/i, '').replace(/^(?:a|an|the|my|our)\s+/i, '');
}
