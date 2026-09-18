import { assessProblemClarity, buildRequestReadiness, requestEvidenceKey } from '../../src/services/booking/requestQualificationPolicy.service.js';
import { evaluateServiceAreaPolicy } from '../../src/services/scheduling/serviceAreaPolicy.service.js';

const assess = (service, options = {}) => assessProblemClarity({ service, text: service, ...options });
test.each([
  'My toilet is broken', 'My AC is not working', 'My outlet is broken', 'My roof has damage',
  'Restoration for damage', 'My garage door will not work', 'My door lock is broken', 'My sprinkler has a problem',
])('requires clarification across trades: %s', service => {
  expect(assess(service)).toMatchObject({ status: 'needs_clarification', reason: 'problem_detail_required' });
});
test.each(['Replace my faucet', 'AC maintenance', 'Outlet installation', 'Roof inspection', 'Water damage restoration', 'Garage door stuck open', 'Rekey my door lock', 'Lawn mowing'])('does not interrogate explicit work: %s', service => {
  expect(assess(service).status).toBe('clear');
});
test('out-of-order facts and questions do not answer clarification or consume attempts', () => {
  const previous = { ...assess('My toilet is broken'), asked: true };
  for (const [text, flags] of [['Tuesday', { factualTurn: true }], ['123 Easy Street 35022', { factualTurn: true }], ['How much?', { interrupt: true }]]) {
    expect(assess('My toilet is broken', { previous, text, ...flags })).toMatchObject({ status: 'needs_clarification', attempts: 0 });
  }
  expect(assess('My toilet is broken', { previous, text: "It won't flush" })).toMatchObject({ status: 'clear', evidence: expect.stringContaining("It won't flush") });
  expect(assess('My toilet is broken', { previous, text: "I don't know" }).status).toBe('needs_staff_review');
});
test('bounds unclear answers and replay does not consume attempts twice', () => {
  let previous = { ...assess('My AC is broken'), asked: true };
  previous = assess('My AC is broken', { previous, text: 'something strange', turnId: 'one' });
  expect(previous.attempts).toBe(1);
  previous = assess('My AC is broken', { previous, text: 'something strange', turnId: 'one' });
  expect(previous.attempts).toBe(1);
  expect(assess('My AC is broken', { previous, text: 'still strange', turnId: 'two' }).status).toBe('needs_staff_review');
});
test('configured clarification and detail vocabulary work without regex injection', () => {
  const policy = { requireClarification: true, clarificationQuestion: 'Which component needs repair?', detailKeywords: ['drive belt', '.*'] };
  const previous = { ...assess('equipment repair', { policy }), asked: true };
  expect(previous.question).toBe(policy.clarificationQuestion);
  expect(assess('equipment repair', { policy, previous, text: 'anything' }).status).toBe('needs_clarification');
  expect(assess('equipment repair', { policy, previous, text: 'the drive belt' }).status).toBe('clear');
});
test('changed service does not reuse the previous problem answer', () => {
  const previous = assess('toilet clogged');
  expect(assess('My AC is broken', { previous }).status).toBe('needs_clarification');
});

test.each([
  [null, '30318', null, 'service_area_not_configured'],
  [{ type: 'zip_codes', zipCodes: [] }, '30318', null, 'service_area_not_configured'],
  [{ type: 'zip_codes', zipCodes: ['30318'] }, '', null, 'zip_code_required'],
  [{ type: 'zip_codes', zipCodes: ['30318-1234'] }, '30318', true, 'matched'],
  [{ type: 'zip_codes', zipCodes: ['30318'] }, '35022', false, 'outside_configured_service_area'],
  [{ type: 'unrestricted' }, '35022', true, 'explicitly_unrestricted'],
  [{ type: 'unsupported_mode' }, '30318', null, 'service_area_configuration_incomplete'],
])('coverage policy case %#', async (area, postalCode, supported, reason) => {
  expect(await evaluateServiceAreaPolicy({ area, postalCode })).toMatchObject({ supported, reason, policyVersion: 1 });
});
test('radius uses real distance evidence, never zero/null/NaN defaults on failure', async () => {
  const area = { type: 'radius', centerPostalCode: '30318', radiusMiles: 25 };
  for (const distance of [null, NaN, Infinity, -1]) expect((await evaluateServiceAreaPolicy({ area, postalCode: '35022', distanceResolver: async () => distance })).supported).toBeNull();
  expect((await evaluateServiceAreaPolicy({ area, postalCode: '35022', distanceResolver: async () => 30 })).supported).toBe(false);
  expect((await evaluateServiceAreaPolicy({ area, postalCode: '30318', distanceResolver: async () => 0 })).supported).toBe(true);
  expect((await evaluateServiceAreaPolicy({ area, postalCode: '35022', distanceResolver: async () => { throw Error('offline'); } })).reason).toBe('service_area_validation_unavailable');
});
test('readiness binds availability to current facts and freshness', () => {
  const now = new Date('2026-09-18T20:00:00Z');
  const lead = { serviceNeeded: 'toilet clogged', address: '123 Easy Street 35022', preferredAppointmentTime: 'Tuesday at 13:00' };
  const conversation = { serviceEligibility: { decision: 'supported', serviceId: 'toilet' } };
  const state = { problem: assess(lead.serviceNeeded), coverage: { supported: true, address: lead.address } };
  const context = { lead, conversation, state, now };
  expect(buildRequestReadiness(context)).toMatchObject({ readyForOptions: true, readyForApproval: false });
  state.availability = { status: 'available', checkedAt: now.toISOString(), evidenceKey: requestEvidenceKey(context) };
  expect(buildRequestReadiness(context).readyForApproval).toBe(true);
  expect(buildRequestReadiness({ ...context, now: new Date(now.getTime() + 300001) }).readyForApproval).toBe(false);
  lead.preferredAppointmentTime = 'Wednesday';
  expect(buildRequestReadiness(context).readyForApproval).toBe(false);
  state.coverage.supported = null;
  expect(buildRequestReadiness(context)).toMatchObject({ readyForStaffReview: true, readyForOptions: false });
});

test('negative danger evidence alone cannot resolve a vague malfunction', () => {
 const previous = { ...assess('My toilet is broken'), asked: true };
 expect(assess('My toilet is broken', { previous, text: 'It is not leaking' }).status).toBe('needs_clarification');
 expect(assess('My toilet is broken', { previous, text: "Not leaking, but it won't flush" }).status).toBe('clear');
});
test('symptom evidence survives a combined address and pricing interruption', () => {
 const previous = { ...assess('My toilet is broken'), asked: true };
 const result = assess('My toilet is broken', { previous, text: "It won't flush. 123 Easy Street 35022. How much?", factualTurn: true, interrupt: true });
 expect(result.status).toBe('clear');
 expect(result.evidence).toContain("won't flush");
});
