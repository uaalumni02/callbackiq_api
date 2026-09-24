import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { extractCallbackDetails, isCallbackRequest } from '../../src/voice/voiceInput.service.js';

const extract = (text, serviceNeeded) => extractService(text, { lead: { serviceNeeded } });
test.each(['kitchen sink', 'heat pump', 'garage door', 'ceiling fan', 'front door lock', 'sprinkler'])('action correction preserves %s across replay', subject => {
  let service = `${subject} needs replacement`;
  for (let i = 0; i < 4; i++) service = extract('Can you repair that instead?', service);
  expect(service).toBe(`${subject} repair`);
  expect(extract('What would fixing the same problem cost?', service)).toBe('');
});
test.each(['kitchen sink', 'water heater', 'roof', 'air conditioner'])('current conditions replace old %s conditions without repetition', subject => {
  let service = `${subject} is clogged but there is no leaking or flooding`;
  for (let i = 0; i < 4; i++) service = extract('Actually it is leaking continuously now', service);
  expect(service).toBe(`${subject} is clogged; current condition: leaking continuously now`);
  service = extract('It is no longer leaking', service);
  expect(service).toBe(`${subject} is clogged; current condition: no longer leaking`);
});
test('ambiguous multiple objects are not assigned a guessed action', () => {
  expect(extract('Can you repair that instead?', 'sink and furnace need replacement')).toBe('');
});
test.each(['Friday at 10 am', 'Friday 10 AM', 'Tuesday between 2 pm and 4 pm', 'Tomorrow afternoon'])('callback preserves complete preference %s', text => {
  expect(extractCallbackDetails(text).preference).toBe(text);
});
test('callback extraction keeps full address and does not create a preference from street digits', () => {
  expect(extractCallbackDetails('970 Sidney Marcus Atlanta GA 30324')).toEqual({ location: '970 Sidney Marcus Atlanta GA 30324' });
});
test.each(['Please call me instead', 'Give me a call', 'Call me back'])('callback exit %s is recognized', text => expect(isCallbackRequest(text)).toBe(true));
test.each(["Don't call me", 'Do not call me back', 'I called back', 'Returning your call'])('callback exit does not invert %s', text => expect(isCallbackRequest(text)).toBe(false));

test.each(['after work', 'next Tuesday between 2p and 4p', 'Friday at ten thirty am', '2026-10-02 at 14:00'])('callback time field preserves shared scheduling phrase %s', text => {
 expect(extractCallbackDetails(text, { currentField:'preference' }).preference).toBe(text);
});
test.each(["It's actually leaking continuously now", 'It is rattling', 'It is stuck'])('symptom replay is bounded: %s', text => {
 let current='garage door is broken';
 current=extract(text,current);const first=current;
 for(let i=0;i<4;i++)current=extract(text,current);
 expect(current).toBe(first);expect(current).toContain('garage door');
});

test.each(['repair','replace','install','inspect','clean','fix','remove','paint','trim','reseal','recaulk'])('action %s remains idempotent rather than growing the object', action => {
 let current='garage door needs replacement';
 for(let i=0;i<5;i++)current=extract(`Can you ${action} that instead?`,current);
 expect(current).toBe(`garage door ${action==='fix'?'repair':action}`);
});
