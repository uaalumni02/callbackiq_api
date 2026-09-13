import { evaluateServicePolicy as decide, scoreService } from '../../src/services/serviceEligibility/policy.js';
const plumbing = { _id: 'p', active: true, name: 'Plumbing service', category: 'plumbing', aiCanDiscuss: true, aiCanBook: true, keywords: ['repair', 'install', 'leak'] };
const roofing = { ...plumbing, _id: 'r', name: 'Roofing', category: 'roofing', keywords: ['roof', 'shingles'] };
const assess = (request, extra = {}) => decide({ request, services: [plumbing], policy: { catalogComplete: true }, ...extra });
test.each(['roof repair', 'shingles blew off', 'install a roof', 'electrical outlet repair', 'furnace repair', 'garage door repair', 'rekey a door lock', 'lawn mowing'])('wrong service %s is unsupported', text => {
  expect(assess(text).decision).toBe('unsupported'); expect(scoreService(text, plumbing)).toBe(0);
});
test.each(['repair', 'install', 'leak', 'general service', 'leaks', 'cleaning', 'replacing'])('generic term %s cannot authorize a match', text => expect(assess(text).decision).toBe('needs_clarification'));
test('incomplete catalog requires review instead of inventing a refusal', () => expect(assess('roof repair', { policy: {} }).decision).toBe('needs_staff_review'));
test('global exclusion wins over configured positive keywords', () => expect(assess('roof repair', { services: [roofing], policy: { excludedServices: ['roof repair'] } }).decision).toBe('unsupported'));
test('offering exclusion cannot veto a different legitimate offering', () => {
  expect(assess('roof repair', { services: [{ ...plumbing, excludedKeywords: ['roof repair'] }, roofing] }).decision).toBe('supported');
});
test('ambiguous ceiling water asks about source', () => expect(assess('water leaking through my ceiling').reason).toBe('water_source_uncertain'));
test('unsure remains uncertain', () => expect(assess('unsure: water leaking through ceiling').decision).not.toBe('supported'));
test('multiple trades accepted by actual catalog', () => expect(assess('roof repair', { services: [plumbing, roofing] })).toMatchObject({ decision: 'supported', serviceId: 'r' }));
test('mixed supported/unsupported request cannot be booked as the supported part', () => expect(assess('pipe leak and roof repair').reason).toBe('mixed_service_request'));
test('new correction discards earlier service evidence', () => expect(assess('pipe repair instead roof repair').decision).toBe('unsupported'));
test('negated service cannot authorize work', () => expect(assess('I do not need plumbing, I need roof repair').decision).not.toBe('supported'));
test('normal fault description is not mistaken for negated service', () => expect(assess('my toilet is not working').decision).toBe('supported'));
test('AI cannot override conflicting raw trade evidence', () => expect(assess('roof repair', { semanticService: 'plumbing', confidence: 100 }).decision).toBe('unsupported'));
test('AI description still must match owner catalog and confidence', () => {
  expect(assess('shingles blew off', { services: [roofing], semanticService: 'roof repair', confidence: 90 }).decision).toBe('supported');
  expect(assess('the whatchamacallit', { semanticService: 'plumbing', confidence: 20 }).decision).toBe('needs_staff_review');
});
test('discussion and review permissions remain authoritative', () => {
  expect(assess('toilet repair', { services: [{ ...plumbing, aiCanDiscuss: false }] }).reason).toBe('discussion_requires_staff');
  expect(assess('toilet repair', { services: [{ ...plumbing, requiresHumanReview: true }] }).reason).toBe('service_requires_staff');
  expect(assess('toilet repair', { services: [{ ...plumbing, aiCanBook: false }] })).toMatchObject({ decision: 'supported', canBook: false });
});
