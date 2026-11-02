/** Booking advisory and failure recovery contract tests using inert collaborators. */
import assert from 'node:assert/strict';
import { createBookingInquiryOperations } from '../../src/services/booking/inquiry/bookingInquiryOperations.js';

const service = { id: 'offering-1', name: 'Roof repair', score: 10 };
const slot = { startAt: '2026-11-10T10:00:00Z', endAt: '2026-11-10T11:00:00Z', requiresBusinessApproval: true };
const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0,10);
const business = { _id: 'tenant-1', businessName: 'Service Company', timezone: 'America/New_York' };
const lead = { _id: 'lead-1', serviceNeeded: 'Roof repair', address: '123 Main St 30301', urgency: 'normal' };

function fixture(changes = {}) {
  const alerts = [];
  const updates = [];
  const failures = [];
  const state = { _id: 'conversation-1', bookingState: {}, set(_k, _v) {}, async save() {} };
  const deps = {
    AlertService: { async createSystemAlert(x) { alerts.push(x); } },
    assertDistributedLeaseActive: () => {}, assertVoiceTurnActive: () => {},
    automatedSchedulingNotice: 'Scheduling requires approval.',
    classifySmsIntent: ({ customerMessage }) => ({
      intents: { pricing: /price/i.test(customerMessage) },
      entities: { serviceNeeded: 'Roof repair' },
    }),
    customerAppointmentLabel: x => new Date(x.startAt).toISOString().slice(0,16),
    extractCustomerAddress: x => x,
    extractCustomerPostalCode: () => '30301',
    filterAutomatedSlots: x => x,
    filterSlotsByTimePreference: x => x,
    findDateRange: () => ({ startDate: day, endDate: day }),
    fixedResult: x => x,
    formatDateKey: date => date.toISOString().slice(0,10),
    getApprovedServiceEstimate: async () => 'Approved range: $50-$100.',
    getAvailabilityTool: async () => ({ slots: [slot] }),
    hasAppointmentPreferenceHint: () => false,
    logOperationalError: (...xs) => failures.push(xs), logOperationalEvent: () => {},
    parseTimePreference: () => ({ timeOfDay: null, targetMinutes: null }),
    rankSlotsByTimePreference: x => x,
    requestStaffSchedulingReview: async () => ({ reply: 'Staff will review this request.' }),
    searchServicesTool: async () => [service],
    selectSlotOptions: x => x.slice(0, 3),
    updateState: async (_conversation, patch) => updates.push(patch),
    withoutCustomerPostalCode: x => String(x || '').replace(/\b\d{5}\b/g, ''),
    ...changes,
  };
  return { operations: createBookingInquiryOperations(deps), alerts, updates, failures, conversation: state };
}

const inquiry = (f, text = 'What times are available?', opts = {}) => f.operations.handleReadOnlyAvailabilityInquiry({
  business, lead, conversation: f.conversation, text, ...opts,
});

for (const input of ['yes, 123 Main St, 30301', 'the address is 123 Main St 30301', 'at 123 Main St']) {
  test(`normalizes the known service-address syntax: ${input}`, () => {
    const f = fixture();
    const address = f.operations.cleanStreetAddress(input);
    assert.equal(address, '123 Main St');
    assert.deepEqual(f.operations.parseStreetAddress(input).valid, true);
  });
}

test('pricing advisory never invents a price without business approval', async () => {
  const f = fixture({ getApprovedServiceEstimate: async () => null });
  const price = await f.operations.buildAvailabilityPricingNote({ business, lead, text: 'Price?' });
  assert.match(price, /don’t have a business-approved price range/);
  assert.equal(await f.operations.buildAvailabilityPricingNote({ business, lead, text: 'Hello' }), '');
});

test('approved price is used; failed estimate lookup does not prevent availability', async () => {
  const approved = fixture();
  assert.match(await approved.operations.buildAvailabilityPricingNote({ business, lead, text: 'Price?' }), /Approved range/);
  const unavailable = fixture({ getApprovedServiceEstimate: async () => { throw new Error('pricing offline'); } });
  assert.match(await unavailable.operations.buildAvailabilityPricingNote({ business, lead, text: 'Price?' }), /don’t have a business-approved/);
});

test('unknown service requests clarification without availability lookup', async () => {
  let calls = 0;
  const f = fixture({ getAvailabilityTool: async () => { calls += 1; return {slots: []}; }, classifySmsIntent: () => ({intents: {}, entities: {serviceNeeded: ''}}) });
  const out = await inquiry(f, 'Do you have time?', {lead: {_id:'lead-1', serviceNeeded:'Unknown'}});
  assert.match(out.result.reply, /What service do you need/);
  assert.equal(calls, 0);
});

test('ambiguous catalog offers choices and does not invent available appointments', async () => {
  const f = fixture({searchServicesTool: async () => [{name:'Roof repair'}, {name:'Inspection'}]});
  const out = await inquiry(f);
  assert.match(out.result.reply, /Roof repair, Inspection/);
  assert.doesNotMatch(out.result.reply, /confirmed appointment/i);
});

test('unmatched catalog requires scheduling review, not a fabricated opening', async () => {
  const f = fixture({searchServicesTool: async () => []});
  const out = await inquiry(f, 'Roof leak?');
  assert.match(out.result.reply, /can’t verify live availability/);
  assert.match(out.result.reply, /What day and time would you prefer/);
});

test('service catalog error returns a human-review response and records a system alert', async () => {
  const f = fixture({searchServicesTool: async () => { throw new Error('catalog unavailable'); }});
  const out = await inquiry(f);
  assert.equal(out.handled, true);
  assert.match(out.result.reply, /no appointment is confirmed/);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].businessId, 'tenant-1');
  assert.equal(f.alerts[0].metadata.source, 'service_catalog_lookup_failed');
});

test('service-area rejection never offers a slot', async () => {
  const f = fixture({getAvailabilityTool: async () => ({supportedServiceArea:false, slots:[slot]})});
  const out = await inquiry(f);
  assert.match(out.result.reply, /service-area review/);
  assert.ok(!f.updates.some(u => u.offeredSlots));
});

test('invalid provider availability raises operational review instead of reporting no openings', async () => {
  const f = fixture({getAvailabilityTool: async () => ({slots: null})});
  const out = await inquiry(f);
  assert.match(out.result.reply, /can’t verify live availability/);
  assert.equal(f.alerts.length, 1);
});

test('offered slots preserve staff approval and are saved without confirming an appointment', async () => {
  const f = fixture();
  const out = await inquiry(f);
  assert.match(out.result.reply, /business approval required/);
  const patch = f.updates.find(x => Array.isArray(x.offeredSlots));
  assert.ok(patch);
  assert.equal(patch.status, 'offering_slots');
  assert.equal(patch.offeredSlots[0].requiresBusinessApproval, true);
  assert.equal(patch.offeredSlots[0].selectionSubmits, false);
});

test('empty same-day availability sends staff review, not an automatic confirmation', async () => {
  const f = fixture({ findDateRange: () => { const today = new Date().toISOString().slice(0,10); return {startDate:today,endDate:today}; }, getAvailabilityTool: async()=>({slots:[]}) });
  const out = await inquiry(f);
  assert.match(out.result.reply, /Staff will review/);
});

test('expanded availability honors customer preference and labels fallback accurately', async () => {
  let attempts = 0;
  const f = fixture({
    getAvailabilityTool: async () => ({slots: ++attempts === 1 ? [] : [slot]}),
    parseTimePreference: () => ({ targetMinutes:600, timeOfDay:'morning' }),
  });
  const out = await inquiry(f);
  assert.equal(attempts, 2);
  assert.match(out.result.reply, /Closest matches/);
  assert.match(out.result.reply, /business approval required/);
});

test('expanded availability still empty: request later time, not a guaranteed appointment', async () => {
  const f = fixture({getAvailabilityTool: async()=>({slots:[]})});
  const out = await inquiry(f);
  assert.match(out.result.reply, /What later day could work/);
});

for (const code of ['VOICE_STALE_TURN','DISTRIBUTED_LEASE_LOST']) {
  test(`${code} must propagate and not create duplicate alerts`, async () => {
    const f = fixture();
    const error = Object.assign(new Error('stale'), { code });
    await assert.rejects(() => f.operations.handleAvailabilityProviderFailure({business, lead, conversation:f.conversation, error}), err=>err===error);
    assert.equal(f.alerts.length, 0);
  });
}

test('failed alert notification does not mask the original provider failure', async () => {
  const logs = [];
  const f = fixture({AlertService:{createSystemAlert:async()=>{throw new Error('alert failed');}}, logOperationalError:(...xs)=>logs.push(xs)});
  const out = await f.operations.handleAvailabilityProviderFailure({business, lead, conversation:f.conversation, error:new Error('provider offline')});
  assert.match(out.result.reply, /no appointment is confirmed/);
  assert.ok(logs.length >= 2);
});

test('readiness block includes missing code and never claims a confirmed booking', async () => {
  const f = fixture();
  const out = await f.operations.handleBookingReadinessFailure({business, lead, conversation:f.conversation, readiness:{missingRequirements:{booking:[{code:'NO_PROVIDER', message:'Setup incomplete'}]}}, customerMessage:'book'});
  assert.match(out.result.reply, /no appointment is confirmed/);
  assert.equal(f.alerts[0].metadata.code, 'NO_PROVIDER');
  assert.equal(f.alerts[0].metadata.missingRequirements[0], 'NO_PROVIDER');
});

test('readiness exceptions record provider error while preserving human-review status', async () => {
  const logs=[];
  const f=fixture({logOperationalError:(...x)=>logs.push(x)});
  const out=await f.operations.handleBookingReadinessFailure({business, lead, conversation:f.conversation, error:Object.assign(new Error('not ready'),{code:'BAD_PROVIDER'})});
  assert.match(out.result.reply, /needs team review/);
  assert.equal(f.alerts[0].metadata.code, 'BAD_PROVIDER');
  assert.ok(logs.length > 0);
});

test('readiness alert publishing failure is logged and does not confirm booking', async () => {
  const errors=[];
  const f=fixture({AlertService:{createSystemAlert:async()=>{throw new Error('alerts unavailable');}},logOperationalError:(...xs)=>errors.push(xs)});
  const out=await f.operations.handleBookingReadinessFailure({business, lead, conversation:f.conversation});
  assert.equal(out.handled,true);
  assert.ok(errors.some(([event])=>event==='booking.readiness_alert_failed'));
});
