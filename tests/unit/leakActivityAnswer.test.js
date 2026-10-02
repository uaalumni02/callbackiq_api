import { classifyLeakActivityAnswer } from '../../src/services/booking/leakActivityAnswer.service.js';
const classify = (text, state = { triagePending: true, field: 'leak_activity' }, service = 'sink leaking') => classifyLeakActivityAnswer({ text, state, service });
test.each(['When I use it', 'It leaks when I use it', 'It only leaks when I use it', 'Only when running', 'During use'])('use-dependent evidence: %s', text => expect(classify(text)).toBe('during_use'));
test.each(['When I use it, it does not leak', 'When I use it?', 'Not when I use it', 'Tomorrow', '123 Main Street', 'When I use it but now water is gushing', 'Only when I use it, but it leaks constantly now'])('does not invent reassurance from: %s', text => expect(classify(text)).toBeNull());
test.each([{ field: 'address', triagePending: true }, { field: 'leak_activity', triagePending: false }, { field: 'leak_substance', triagePending: true }])('requires an outstanding activity question: %j', state => expect(classify('When I use it', state)).toBeNull());
test('rain has a roof-specific interpretation', () => {
 expect(classify('During rain', undefined, 'roof leak')).toBe('during_rain');
 expect(classify('During rain')).toBeNull();
});
