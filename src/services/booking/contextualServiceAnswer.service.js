import { TRADE_DOMAINS } from '../trades/tradeProfiles.service.js';
// Symptom evidence belongs to the existing request. Only explicit objects or
// requests may replace its identity; pronouns and elliptical condition updates
// must not enter noun-correction or catalog matching as a new job.
export function isContextualSymptomAnswer(text, service) {
  if (!service || /^(unknown|not provided|n\/a)$/i.test(String(service).trim())) return false;
  const value = String(text || '').replace(/[’‘]/g, "'").trim();
  if (/\b(?:and|but|also)\s+(?:(?:now|also)\s+)?(?:my|our|the|a|an)\s+/i.test(value)) return false;
  if (/\b(?:instead|rather than|another|also need|new job|different job)\b/i.test(value)) return false;
  if (/\b(?:i|we)\s+(?:need|want|would like)\b|\b(?:repair|replace|install)\s+(?:a|an|my|the)\b/i.test(value)) return false;
  // A newly named object is service evidence, even in an elliptical phrase
  // such as 'leaking roof'. Ignore objects inside an activity condition.
  const subjectClause = value.split(/\b(?:when|while|during|after)\b/i)[0];
  const known = String(service).toLowerCase();
  for (const pattern of Object.values(TRADE_DOMAINS)) {
    const objects = subjectClause.match(new RegExp(pattern.source, 'gi')) || [];
    if (objects.some(object => !known.includes(object.toLowerCase()))) return false;
  }
  // A stated object/correction is left to the existing service parser. This
  // covers every trade without treating a new named fixture as an old symptom.
  return /^(?:(?:yes|yeah|yep|no|nope)[, ]+)?(?:(?:it(?:'s| is| has)?|its|that(?:'s| is)?|this(?: is)?)\s+(?:(?:still|now|just|only|no longer|not|isn't|is not|won't|will not|doesn't|does not|has|hasn't|keeps?)\s+)*|(?:still|now|only|no longer|not)\s+)?(?:leak(?:s|ing)?|drip(?:s|ping)?|heat(?:s|ing)?|cool(?:s|ing)?|work(?:s|ing)?|run(?:s|ning)?|open(?:s|ing)?|clos(?:e|es|ing)|lock(?:s|ing)?|drain(?:s|ing)?|spread(?:s|ing)?|stopp?ed|broken|stuck|wet|dry|dead|making\s+(?:a\s+)?noise)\b/i.test(value);
}
