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
import { ownerInterventionFilter } from '../../src/services/ownerExperience.service.js';
const oid = () => new mongoose.Types.ObjectId();
beforeAll(connectTestDB, 120000);
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
  await Appointment.collection.insertMany([{ business, lead: lead._id, status: 'completed', actualRevenue: 275, createdAt: new Date(0) },
    ...Array.from({length: 60}, () => ({ business, lead: lead._id, status: 'canceled', createdAt: new Date() }))]);
  const summary = await readCustomerSummary({ businessId: business, lead });
  expect(summary).toMatchObject({ actualRevenue: 275, customerLifecycleStatus: 'recovered', appointmentCount: 61 });
  expect((await Lead.findById(lead._id).lean()).customerLifecycleStatus).toBe('new');
});
test('owner cursors preserve equal timestamp records and workflow filters across tenants', async () => {
  const business = { _id: oid(), features: {} }, date = new Date();
  const leads = Array.from({ length: 6 }, (_, i) => ({ _id: oid(), business: business._id, status: 'new', customerName: `Customer ${i}`, serviceNeeded: 'repair', address: '1 Main', preferredAppointmentTime: 'tomorrow', updatedAt: date, createdAt: date }));
  await Lead.collection.insertMany([...leads, { ...leads[0], _id: oid(), business: oid() }]);
  await Alert.collection.insertOne({ business: business._id, lead: leads[0]._id, type: 'human_requested', resolvedAt: null });
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
  const options = { business, interventionFilter: ownerInterventionFilter(business._id) };
  expect(await queryOwnerOpportunities({ ...options, view: 'all' })).toMatchObject({ stats: { active: 1, booked: 120, readyToSchedule: 1 }, pagination: { total: 151 } });
  expect(await queryOwnerOpportunities({ ...options, view: 'not_booked' })).toMatchObject({ pagination: { total: 30 } });
});
