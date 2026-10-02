import { detectSafetyHazardType } from '../../src/helpers/ai/aiGuardrails.js';
test.each([
 ['The technician was injured', 'medical'], ['Someone was unconscious', 'medical'],
 ['The wires were sparking', 'electrical'], ['A child was trapped inside', 'trapped'],
 ['There was smoke in the kitchen', 'fire'],
])('tense alone cannot dismiss reported danger: %s', (text, hazard) => expect(detectSafetyHazardType(text)).toBe(hazard));
test.each([
 'The technician was not injured', 'There was no smoke', 'The wires were not sparking',
 'The gas leak was repaired yesterday. I need the invoice.',
 'There was smoke earlier but there is none now.',
 'There was smoke but there is none now.',
 'There was smoke but it is gone',
])('explicit negation or historical context stays non-emergency: %s', text => expect(detectSafetyHazardType(text)).toBe(''));
