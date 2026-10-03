import { leakContext } from '../trades/tradeProfiles.service.js';

// Short answers have meaning only while this journey is waiting for leak
// activity. Do not interpret dates, unrelated yes/no replies, questions, or
// compound statements as evidence that a leak has stopped.
export function classifyLeakActivityAnswer({ text, state, service }) {
  if (!state?.triagePending || state.field !== 'leak_activity') return null;
  const answer = String(text || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
  if (/[?]/.test(answer)) return null;
  // Resolve conditions before bare activity so 'leaks when...' is not active now.
  if (/\b(?:when|while|during)\b/i.test(answer) && /\b(?:use|using|run|running|turn|turned|faucet|tap)\b/i.test(answer) && !/\b(?:not|no|never|doesn't|isn't|but|however|also|even|constantly|all the time)\b/i.test(answer)) return 'during_use';
  if (/\b(?:stopped|no longer leaking|not leaking)\b/i.test(answer) && !/\b(?:but|however|again|still leaking)\b/i.test(answer)) return 'not_active';
  if (/^(?:(?:it|the (?:sink|toilet|shower|tub|faucet|washer|dishwasher)) (?:only )?leaks? )?(?:(?:only|just) )?(?:when (?:i|we|you) (?:use (?:it|the (?:sink|toilet|shower|tub|faucet|washer|dishwasher))|run (?:it|the water))|while (?:(?:i|we|you) (?:am |are )?)?using it|during use|when (?:it's |it is )?running)$/i.test(answer)) return 'during_use';
  if (leakContext(service) === 'roof' && /^(?:(?:only|just) )?(?:when it rains|during (?:the )?rain|when (?:it's |it is )?raining)$/i.test(answer)) return 'during_rain';
  if (/^(?:(?:yes|yeah|yep)[, ]+)?(?:(?:it(?:'s| is)|its|the (?:sink|pipe|faucet) is) )?(?:still )?leaking(?: (?:bad(?:ly)?|a lot|heavily|quite a bit|really bad|right now|now))+$/i.test(answer)) return 'active';
  if (/^(?:(?:yes|yeah|yep)[, ]+)?(?:(?:(?:it(?:'s| is)|the (?:sink|pipe|faucet) is) )?(?:still )?leaking(?: (?:right )?now)?|right now|all the time|constantly|continuously|nonstop|still leaking|it's still leaking|it is still leaking)$/i.test(answer)) return 'active';
  if (/^(?:(?:no|nope)[, ]+)?(?:not (?:right now|anymore|any more|currently)|no longer|stopped|it stopped|it has stopped|it's stopped|it is stopped)$/i.test(answer)) return 'not_active';
  return null;
}
