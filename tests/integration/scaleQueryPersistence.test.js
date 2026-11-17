import { persistInboundSmsMessage } from '../../src/services/messaging/smsIngressPersistence.service.js';
import { recomputeLeadWorkflowFlags, sweepLeadWorkflow } from '../../src/services/stateTransitions/leadWorkflow.js';
import CallLog from '../../src/models/callLog.js';
import mongoose from 'mongoose';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import Appointment from '../../src/models/appointment.js';
import Alert from '../../src/models/alert.js';
import { readCustomerHistory, readCustomerSummary } from '../../src/services/scale/customerHistory.service.js';
import { queryOwnerOpportunities } from '../../src/services/scale/ownerOpportunityQuery.service.js';
import { withSmsTenantSlot } from '../../src/services/scale/smsTenantFairness.service.js';
import OwnerExperienceService, { ownerInterventionFilter } from '../../src/services/ownerExperience.service.js';
const oid = () => new mongoose.Types.ObjectId();
beforeAll(async () => {
  await connectTestDB();
  // Raw collection fixtures must satisfy the real unique index regardless of
  // whether background model initialization wins the first insert race.
  await Appointment.init();
}, 120000);
afterEach(async () => { delete process.env.SMS_TENANT_MAX_CONCURRENCY; if (mongoose.connection.readyState === 1) await clearTestDB(); });
afterAll(async () => { if (mongoose.connection.readyState === 1) await closeTestDB(); });
test('history traverses every older message once, includes legacy links, and excludes another tenant', async () => {
  const business = oid(), lead = { _id: oid(), phone: '+14045550123' }, conversation = oid(), date = new Date();
  await Conversation.collection.insertOne({ _id: conversation, business, lead: lead._id, customerPhone: lead.phone, createdAt: date });
  await Message.collection.insertMany(Array.from({ length: 123 }, (_, i) => ({ _id: oid(), business, ...(i % 2 ? { lead: lead._id } : {}), conversation, body: `message ${i}`, createdAt: date })));
  await Message.collection.insertOne({ _id: oid(), business: oid(), lead: lead._id, conversation, body: 'private', createdAt: date });
  let cursor, ids = [];
  do { const page = await readCustomerHistory({ businessId: business, lead, section: 'messages', limit: 20, cursor });
    expect(page.items.length).toBeLessThanOrEqual(20); expect(page.items.every(x => x.body !== 'private')).toBe(true);
    ids.push(...page.items.map(x => String(x._id))); cursor = page.pagination.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(123); expect(new Set(ids).size).toBe(123);
});
test('old completed appointments remain in all-history totals and reads do not update lifecycle', async () => {
  const business = oid(), lead = { _id: oid(), phone: '+14045550124', status: 'new', customerLifecycleStatus: 'new' };
  await Lead.collection.insertOne({ ...lead, business });
  await Appointment.collection.insertMany([{ business, lead: lead._id, idempotencyKey: 'history-completed', status: 'completed', actualRevenue: 275, createdAt: new Date(0) },
    ...Array.from({length: 60}, (_, i) => ({ business, lead: lead._id, idempotencyKey: `history-canceled-${i}`, status: 'canceled', createdAt: new Date() }))]);
  const summary = await readCustomerSummary({ businessId: business, lead });
  expect(summary).toMatchObject({ actualRevenue: 275, customerLifecycleStatus: 'recovered', appointmentCount: 61 });
  expect((await Lead.findById(lead._id).lean()).customerLifecycleStatus).toBe('new');
});
test('owner cursors preserve equal timestamp records and workflow filters across tenants', async () => {
  const business = { _id: oid(), features: {} }, date = new Date();
  const leads = Array.from({ length: 6 }, (_, i) => ({ _id: oid(), business: business._id, status: 'new', customerName: `Customer ${i}`, serviceNeeded: 'repair', address: '1 Main', preferredAppointmentTime: 'tomorrow', updatedAt: date, createdAt: date }));
  await Lead.collection.insertMany([...leads, { ...leads[0], _id: oid(), business: oid() }]);
  await Alert.collection.insertOne({ business: business._id, lead: leads[0]._id, type: 'human_requested', resolvedAt: null });
  for (const lead of leads) await recomputeLeadWorkflowFlags(business._id, lead._id);
  const options = { business, interventionFilter: ownerInterventionFilter(business._id), includeSummary: false, limit: 2 };
  let cursor, ids = [];
  do { const page = await queryOwnerOpportunities({ ...options, cursor }); ids.push(...page.rows.map(x => String(x._id))); cursor = page.pagination.nextCursor; } while(cursor);
  expect(new Set(ids).size).toBe(6);
  const needs = await queryOwnerOpportunities({ ...options, view: 'needs_me' });
  expect(needs.rows.map(x => String(x._id))).toEqual([String(leads[0]._id)]);
  const ready = await queryOwnerOpportunities({ ...options, view: 'ready', limit: 20 }); expect(ready.rows).toHaveLength(5);
});
test('tenant slots limit overlapping jobs while another business can continue', async () => {
  process.env.SMS_TENANT_MAX_CONCURRENCY = '1';
  const business = oid(); let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = withSmsTenantSlot(business, async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await began;
  try {
    expect((await withSmsTenantSlot(business, async () => { throw new Error('must not run'); })).acquired).toBe(false);
    expect((await withSmsTenantSlot(oid(), async () => 'other')).value).toBe('other');
  } finally { release(); await pending; }
  expect((await withSmsTenantSlot(business, async () => 'again')).value).toBe('again');
});

test('summary counts retain historical booked/lost totals while workflow joins use active leads', async () => {
  const business = { _id: oid(), features: {} };
  const common = { business: business._id, createdAt: new Date(), updatedAt: new Date() };
  await Lead.collection.insertMany([
    { ...common, status: 'new', serviceNeeded: 'repair', address: '1 Main', preferredAppointmentTime: 'tomorrow' },
    ...Array.from({ length: 120 }, () => ({ ...common, status: 'booked' })),
    ...Array.from({ length: 30 }, () => ({ ...common, status: 'lost' })),
  ]);
  const active = await Lead.findOne({ business: business._id, status: 'new' });
  await recomputeLeadWorkflowFlags(business._id, active._id);
  const options = { business, interventionFilter: ownerInterventionFilter(business._id) };
  expect(await queryOwnerOpportunities({ ...options, view: 'all' })).toMatchObject({ stats: { active: 1, booked: 120, readyToSchedule: 1 }, pagination: { total: 151 } });
  expect(await queryOwnerOpportunities({ ...options, view: 'not_booked' })).toMatchObject({ pagination: { total: 30 } });
});

test('Ready uses the latest tenant conversation eligibility and the same facts as the customer cards', async () => {
  const business = { _id: oid(), features: {} };
  const common = { business: business._id, status: 'new', serviceNeeded: 'repair',
    address: '1 Main', preferredAppointmentTime: 'tomorrow', updatedAt: new Date() };
  const [blocked, supported, fallback, conversationFacts] = Array.from({ length: 4 }, () => oid());
  await Lead.collection.insertMany([
    { ...common, _id: blocked, serviceEligibility: { decision: 'supported' } },
    { ...common, _id: supported, serviceEligibility: { decision: 'unsupported' } },
    { ...common, _id: fallback, serviceEligibility: { decision: 'needs_clarification' } },
    { ...common, _id: conversationFacts, address: '', preferredAppointmentTime: '' },
  ]);
  const at = new Date();
  await Conversation.collection.insertMany([
    { business: business._id, lead: blocked, lastMessageAt: at, serviceEligibility: { decision: 'unsupported' } },
    { business: business._id, lead: blocked, lastMessageAt: new Date(0), serviceEligibility: { decision: 'supported' } },
    { business: business._id, lead: supported, lastMessageAt: at, serviceEligibility: { decision: 'supported' } },
    { business: oid(), lead: supported, lastMessageAt: new Date(at.getTime() + 1000), serviceEligibility: { decision: 'unsupported' } },
    { business: business._id, lead: fallback, lastMessageAt: at },
    { business: business._id, lead: conversationFacts, lastMessageAt: at,
      bookingState: { streetAddress: '1 Main', lastCustomerPreference: 'tomorrow' } },
  ]);
  for (const id of [blocked, supported, fallback, conversationFacts]) await recomputeLeadWorkflowFlags(business._id, id);
  const page = await OwnerExperienceService.opportunities({ business, view: 'ready' });
  expect(page.stats.readyToSchedule).toBe(2);
  expect(page.pagination.total).toBe(2);
  expect(page.items.map(row => row.id).sort()).toEqual([String(supported), String(conversationFacts)].sort());
  expect(page.items.every(row => row.nextAction.kind === 'schedule')).toBe(true);
  const excluded = await OwnerExperienceService.opportunity({ business, leadId: blocked });
  expect(excluded.nextAction.label).toBe('Service not offered');
});

test('Inbox workflow views match the legacy flags on a mixed set of active and historical leads', async () => {
  const business = { _id: oid(), features: {} };
  const common = { business: business._id, status: 'new', serviceNeeded: 'repair',
    address: '1 Main', preferredAppointmentTime: 'tomorrow', updatedAt: new Date() };
  const ids = Object.fromEntries(['ready', 'waiting', 'takeover', 'alert', 'held', 'lost', 'ineligible']
    .map(name => [name, oid()]));
  await Lead.collection.insertMany(Object.entries(ids).map(([name, _id]) => ({
    ...common, _id, status: name === 'lost' ? 'lost' : 'new',
    ...(name === 'ineligible' ? { serviceEligibility: { decision: 'needs_staff_review' } } : {}),
  })));
  await Conversation.collection.insertMany([
    { business: business._id, lead: ids.waiting, status: 'open', bookingState: { status: 'offering_slots' } },
    { business: business._id, lead: ids.takeover, status: 'open', humanTakeover: true },
    { business: oid(), lead: ids.ready, status: 'open', humanTakeover: true },
  ]);
  await Alert.collection.insertOne({ business: business._id, lead: ids.alert, type: 'human_requested', resolvedAt: null });
  await Appointment.collection.insertOne({ business: business._id, lead: ids.held, idempotencyKey: 'parity-held', status: 'held' });

  for (const id of Object.values(ids)) await recomputeLeadWorkflowFlags(business._id, id);
  const expected = { ready: ['ready', 'waiting'], waiting: ['waiting'], needs_me: ['takeover', 'alert'] };
  for (const [view, names] of Object.entries(expected)) {
    const { rows } = await queryOwnerOpportunities({
      business, interventionFilter: ownerInterventionFilter(business._id), view, includeSummary: false,
    });
    expect(rows.map(row => String(row._id)).sort()).toEqual(names.map(name => String(ids[name])).sort());
  }
  expect((await queryOwnerOpportunities({
    business: { ...business, features: { aiBookingEnabled: true } },
    interventionFilter: ownerInterventionFilter(business._id), view: 'ready', includeSummary: false,
  })).rows).toEqual([]);
});

test('lead, conversation, appointment and alert writes refresh the persisted flags', async () => {
  const business = oid();
  const lead = await Lead.create({ business, phone: '+14045550125', serviceNeeded: 'repair',
    address: '1 Main', preferredAppointmentTime: 'tomorrow' });
  const flags = () => Lead.findById(lead._id).lean().then(row => row.workflowFlags);
  expect(await flags()).toMatchObject({ ready: true, needsMe: false, waiting: false });

  const conversation = await Conversation.create({ business, lead: lead._id, customerPhone: lead.phone, status: 'open' });
  await Conversation.updateOne({ _id: conversation._id, business }, {
    $set: { 'bookingState.status': 'offering_slots', humanTakeover: true },
  });
  expect(await flags()).toMatchObject({ ready: false, needsMe: true, waiting: true });
  await Conversation.deleteOne({ _id: conversation._id, business });
  expect(await flags()).toMatchObject({ ready: true, needsMe: false, waiting: false });

  const appointment = await Appointment.create({ business, lead: lead._id, serviceOffering: oid(),
    customerPhone: lead.phone, status: 'held', startAt: new Date(Date.now() + 3600000),
    endAt: new Date(Date.now() + 7200000), idempotencyKey: 'workflow-held' });
  expect(await flags()).toMatchObject({ ready: false });
  await Appointment.deleteOne({ _id: appointment._id, business });
  expect(await flags()).toMatchObject({ ready: true });

  const alert = await Alert.create({ business, lead: lead._id, type: 'human_requested', title: 'Review', message: 'Review this request' });
  expect(await flags()).toMatchObject({ ready: false, needsMe: true });
  await Alert.updateOne({ _id: alert._id, business }, { $set: { resolvedAt: new Date() } });
  expect(await flags()).toMatchObject({ ready: true, needsMe: false });
  await Lead.updateOne({ _id: lead._id, business }, { $set: { address: '' } });
  expect(await flags()).toMatchObject({ ready: false, computedAt: expect.any(Date) });
});

test('bounded archive sweep preserves status, skips protected leads and new inbound activity restores visibility', async () => {
  const business = { _id: oid(), features: {} };
  const now = new Date();
  const old = new Date(+now - 31 * 86400000);
  const [sms, call, booking, review, future] = [1, 2, 3, 4, 5].map(() => oid());
  await Lead.collection.insertMany([sms, call, booking, review, future].map((_id, index) => ({
    _id, business: business._id, status: 'contacted', phone: `+1404555010${index}`,
    createdAt: old, updatedAt: old, serviceNeeded: 'repair',
  })));
  await Alert.collection.insertOne({ business: business._id, lead: review, type: 'human_requested', resolvedAt: null });
  await Appointment.collection.insertOne({ business: business._id, lead: future, idempotencyKey: 'protected-future',
    status: 'confirmed', startAt: new Date(+now + 86400000) });
  await sweepLeadWorkflow({ now });
  const archived = await Lead.find({ business: business._id, archivedAt: { $ne: null } }).lean();
  expect(archived.map(row => String(row._id)).sort()).toEqual([sms, call, booking].map(String).sort());
  expect(archived.every(row => row.status === 'contacted' && row.archiveReason === 'inactive')).toBe(true);
  const options = { business, interventionFilter: ownerInterventionFilter(business._id), includeSummary: false };
  expect((await queryOwnerOpportunities(options)).rows).toHaveLength(2);
  expect((await queryOwnerOpportunities({ ...options, view: 'all' })).rows).toHaveLength(5);

  const inbound = new Date(+now + 500);
  const conversation = await Conversation.create({ business: business._id, lead: sms, customerPhone: '+14045550100' });
  await Message.create({ business: business._id, conversation: conversation._id, lead: sms, direction: 'inbound',
    from: '+14045550100', to: '+14045550199', body: 'New request', createdAt: inbound });
  await CallLog.create({ business: business._id, direction: 'inbound',
    from: '+14045550101', to: '+14045550199', createdAt: inbound });
  await Appointment.create({ business: business._id, lead: booking, serviceOffering: oid(),
    customerPhone: '+14045550102', status: 'held', startAt: new Date(+now + 3600000),
    endAt: new Date(+now + 7200000), createdAt: inbound, updatedAt: inbound, idempotencyKey: 'restored-by-booking' });
  expect((await queryOwnerOpportunities(options)).rows).toHaveLength(5);
  expect(await Lead.countDocuments({ business: business._id, archiveReason: 'inactive' })).toBe(0);
});

test('ready page uses the compound index before display hydration and caps oversized requests', async () => {
  const business = { _id: oid(), features: {} };
  await Lead.init();
  await Lead.collection.insertMany(Array.from({ length: 110 }, (_, index) => ({
    business: business._id, status: index % 2 ? 'new' : 'contacted', workflowFlags: { ready: true },
    updatedAt: new Date(index),
    ...(index >= 105 ? { archivedAt: new Date() } : {}),
  })));
  const aggregate = jest.spyOn(Lead, 'aggregate');
  let result, pipeline, options;
  try {
    result = await queryOwnerOpportunities({
      business, interventionFilter: ownerInterventionFilter(business._id), view: 'ready', limit: 250, includeSummary: false,
    });
    pipeline = aggregate.mock.calls[0][0];
    options = aggregate.mock.results[0].value.options;
  } finally {
    aggregate.mockRestore();
  }

  expect(result.rows).toHaveLength(100);
  expect(result.rows.every(lead => !lead.archivedAt)).toBe(true);
  expect(result.pagination).toMatchObject({ limit: 100, maxLimit: 100, hasMore: true });
  const limitStage = pipeline.findIndex(stage => stage.$limit);
  expect(limitStage).toBeGreaterThanOrEqual(0);
  expect(pipeline.slice(0, limitStage).some(stage => stage.$lookup)).toBe(false);
  expect(pipeline.slice(limitStage + 1).some(stage => stage.$lookup)).toBe(true);
  const execution = await Lead.aggregate(pipeline).option(options).explain('executionStats');
  const cursor = execution.stages.find(stage => stage.$cursor).$cursor;
  expect(JSON.stringify(cursor.queryPlanner.winningPlan)).toContain('lead_workflow_ready');
});

test('batched inbound SMS reopens each archived lead without adding message readbacks', async () => {
  const business = oid();
  const archivedAt = new Date(Date.now() - 86400000);
  const leads = await Lead.collection.insertMany([1, 2].map(index => ({
    business, archivedAt, archiveReason: 'inactive', status: 'contacted', phone: `+1404555010${index}`,
  })));
  const ids = Object.values(leads.insertedIds);
  const read = jest.spyOn(Message, 'find');
  try {
    await Promise.all(ids.map((lead, index) => {
      const filter = { business, providerMessageId: `SM_ARCHIVE_${index}` };
      const fields = { ...filter, lead, conversation: oid(), direction: 'inbound',
        from: '+14045550125', to: '+14045550199', body: 'New request' };
      return persistInboundSmsMessage(filter, { $setOnInsert: fields }, {
        upsert: true, returnDocument: 'after', setDefaultsOnInsert: true,
      });
    }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(await Lead.countDocuments({ business, archivedAt: null, status: 'contacted' })).toBe(2);
  } finally {
    read.mockRestore();
  }
});
