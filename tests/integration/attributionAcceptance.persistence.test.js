import { linkRecentTrackedCalls } from '../../src/services/messaging/trackedCallLink.service.js';
import mongoose from 'mongoose';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import CallLog from '../../src/models/callLog.js';
import TrackingNumber from '../../src/models/trackingNumber.js';
import MarketingSource, { MARKETING_SOURCE_CHANNELS } from '../../src/models/marketingSource.js';
import AttributionTouch from '../../src/models/attributionTouch.js';
import { resolveTrackingNumberContext, syncLatestAttribution, getLatestCallAttribution } from '../../src/services/marketingAttribution.service.js';
import { getAttributionReport } from '../../src/services/marketingAttributionReport.service.js';

// Real isolated MongoDB; never reads .env or uses a supplied database URI.
const oid = () => new mongoose.Types.ObjectId();
const date = new Date('2026-10-03T14:00:00Z');
let business, source, number, lead, conversation;
beforeAll(async () => {
  await connectTestDB();
  await Promise.all([Business, Lead, Conversation, CallLog, TrackingNumber, MarketingSource, AttributionTouch].map(model => model.init()));
}, 120000);
afterEach(clearTestDB);
afterAll(closeTestDB);
beforeEach(async () => {
  business = oid(); lead = oid(); conversation = oid();
  source = { _id: oid(), business, name: 'Search campaign', nameKey: 'search campaign', channel: 'google_ads', campaign: 'Fall service', status: 'active', monthlySpend: 200 };
  number = { _id: oid(), business, marketingSource: source._id, phoneNumber: '+14045550123', phoneLookup: '+14045550123', status: 'active', isPrimary: false };
  await Business.collection.insertOne({ _id: business, isActive: true });
  await MarketingSource.collection.insertOne(source);
  await TrackingNumber.collection.insertOne(number);
  await Lead.collection.insertOne({ _id: lead, business, status: 'booked', leadQualityScore: 85, estimatedValue: 500, valuation: { source: 'owner' }, actualRevenue: 300 });
  await Conversation.collection.insertOne({ _id: conversation, business, lead });
});
const sync = (extra = {}) => syncLatestAttribution({ businessId: business, leadId: lead, conversationId: conversation, trackingNumber: number, marketingSource: source, callLogId: oid(), ...extra });
const call = async (extra = {}) => {
  const row = { _id: oid(), business, lead, marketingSource: source._id, trackingNumber: number._id, from: '+14045550999', createdAt: date, disposition: 'missed', ...extra };
  await CallLog.collection.insertOne(row); return row;
};
const report = (extra = {}) => getAttributionReport({ businessId: business, ...extra });

test.each(MARKETING_SOURCE_CHANNELS)('resolves %s from the called tracking number', async channel => {
  await MarketingSource.collection.updateOne({ _id: source._id }, { $set: { channel } });
  const result = await resolveTrackingNumberContext('(404) 555-0123');
  expect(String(result.business._id)).toBe(String(business));
  expect(result.attribution).toMatchObject({ sourceId: String(source._id), channel, campaign: 'Fall service', trackingNumber: number.phoneNumber });
});
test('unknown and inactive numbers are not attributed', async () => {
  expect(await resolveTrackingNumberContext('+14045550124')).toBeNull();
  await TrackingNumber.collection.updateOne({ _id: number._id }, { $set: { status: 'released' } });
  expect(await resolveTrackingNumberContext(number.phoneNumber)).toBeNull();
});
test('inactive businesses are not resolved', async () => {
  await Business.collection.updateOne({ _id: business }, { $set: { isActive: false } });
  expect(await resolveTrackingNumberContext(number.phoneNumber)).toBeNull();
});
test('first source is preserved while latest source and SMS reply number change', async () => {
  await sync();
  const nextSource = { ...source, _id: oid(), name: 'Referral', channel: 'referral' };
  const nextNumber = { ...number, _id: oid(), phoneNumber: '+14045550124' };
  await sync({ marketingSource: nextSource, trackingNumber: nextNumber });
  const saved = await Lead.findById(lead).lean();
  expect(String(saved.firstMarketingSource)).toBe(String(source._id));
  expect(String(saved.latestMarketingSource)).toBe(String(nextSource._id));
  expect(saved.firstAttribution.sourceName).toBe('Search campaign');
  expect((await Conversation.findById(conversation).lean()).replyFromPhone).toBe(nextNumber.phoneNumber);
});
test('legacy first-touch uses the earliest persisted call', async () => {
  const oldSource = oid(), oldNumber = oid();
  await call({ marketingSource: oldSource, trackingNumber: oldNumber, attribution: { sourceName: 'Original campaign' }, createdAt: new Date('2026-09-01') });
  await sync();
  const saved = await Lead.findById(lead).lean();
  expect(String(saved.firstMarketingSource)).toBe(String(oldSource));
  expect(saved.firstAttribution.sourceName).toBe('Original campaign');
  expect(String(saved.latestMarketingSource)).toBe(String(source._id));
});
test('webhook retries retain one immutable attribution touch per call', async () => {
  const callLogId = oid();
  await sync({ callLogId });
  await sync({ callLogId, marketingSource: { ...source, name: 'Renamed later' } });
  const touches = await AttributionTouch.find({ business }).lean();
  expect(touches).toHaveLength(1);
  expect(touches[0].source).toBe('Search campaign');
  expect(String(touches[0].lead)).toBe(String(lead));
  expect(touches[0].confidence).toBe('high');
});
test('concurrent retries produce one persisted touch', async () => {
  const callLogId = oid();
  await Promise.all(Array.from({ length: 8 }, () => sync({ callLogId })));
  expect(await AttributionTouch.countDocuments({ business, callLog: callLogId })).toBe(1);
});
test('a second distinct call produces a second touch', async () => {
  await sync(); await sync();
  expect(await AttributionTouch.countDocuments({ business })).toBe(2);
});
test('lead/conversation updates cannot cross business boundaries', async () => {
  await sync({ businessId: oid(), callLogId: null });
  expect((await Lead.findById(lead).lean()).latestMarketingSource).toBeUndefined();
  expect((await Conversation.findById(conversation).lean()).replyFromPhone).toBeUndefined();
});
test('latest call lookup excludes another business with the same caller', async () => {
  await call({ attribution: { sourceName: 'Owned' } });
  await call({ business: oid(), createdAt: new Date('2026-10-04'), attribution: { sourceName: 'Private' } });
  expect((await getLatestCallAttribution({ businessId: business, customerPhone: '(404) 555-0999' })).attribution.sourceName).toBe('Owned');
});
test('repeat calls count once for lead, booking and value within a source', async () => {
  await call({ disposition: 'answered_by_business' });
  await call({ recovered: true });
  const [row] = await report();
  expect(row).toMatchObject({ totalCalls: 2, uniqueCallers: 1, answered: 1, missed: 1, recovered: 1, leads: 1, qualifiedLeads: 1, bookedJobs: 1, estimatedRevenue: 500, actualRevenue: 300, costPerLead: 200, costPerBookedJob: 200, roas: 1.5 });
});
test('date boundaries include matching calls and exclude deleted and foreign calls', async () => {
  await call();
  await call({ createdAt: new Date(date.getTime() - 1) });
  await call({ createdAt: new Date(date.getTime() + 1) });
  await call({ deletedAt: date });
  await call({ business: oid() });
  expect((await report({ start: date.toISOString(), end: date.toISOString() }))[0].totalCalls).toBe(1);
});
test('empty source has zero metrics and undefined cost/ROAS denominators', async () => {
  await MarketingSource.collection.updateOne({ _id: source._id }, { $set: { monthlySpend: 0 } });
  expect((await report())[0]).toMatchObject({ totalCalls: 0, leads: 0, bookedJobs: 0, estimatedRevenue: 0, actualRevenue: 0, costPerLead: null, costPerBookedJob: null, roas: null });
});
test('unsupported service does not count as qualified or estimated revenue', async () => {
  await call();
  await Lead.collection.updateOne({ _id: lead }, { $set: { serviceEligibility: { decision: 'unsupported' } } });
  expect((await report())[0]).toMatchObject({ qualifiedLeads: 0, estimatedRevenue: 0 });
});
test('legacy unverified value does not inflate estimated revenue', async () => {
  await call();
  await Lead.collection.updateOne({ _id: lead }, { $set: { valuation: { source: 'legacy_unverified' } } });
  expect((await report())[0].estimatedRevenue).toBe(0);
});
test('completed appointment revenue overrides stale copied lead dollars', async () => {
  await call();
  await mongoose.connection.collection('appointments').insertOne({ business, lead, status: 'completed', actualRevenue: 725, completedAt: date });
  expect((await report())[0]).toMatchObject({ actualRevenue: 725, estimatedRevenue: 0 });
});
test('a canceled appointment suppresses stale booked lead estimates', async () => {
  await call();
  await mongoose.connection.collection('appointments').insertOne({ business, lead, status: 'canceled', estimatedValue: 500, valuation: { source: 'owner' } });
  expect((await report())[0]).toMatchObject({ estimatedRevenue: 0, actualRevenue: 0 });
});
// Acceptance requirement: UI adds source rows into totals. Credit may be first,
// last or fractional touch, but one job must not become two jobs/double dollars.
test.each([['bookedJobs', 1], ['estimatedRevenue', 500], ['actualRevenue', 300]])('ACCEPTANCE: cross-source calls must not double %s', async (metric, expected) => {
  const second = { ...source, _id: oid(), name: 'Referral', nameKey: 'referral', channel: 'referral' };
  await MarketingSource.collection.insertOne(second);
  await call(); await call({ marketingSource: second._id });
  const rows = await report();
  expect(rows.reduce((sum, row) => sum + row[metric], 0)).toBe(expected);
});

test('saved first source wins even when the later source has more calls', async () => {
  const second = { ...source, _id: oid(), name: 'Second', nameKey: 'second' };
  await MarketingSource.collection.insertOne(second);
  await Lead.collection.updateOne({ _id: lead }, { $set: { firstMarketingSource: source._id } });
  await call({ marketingSource: second._id }); await call({ marketingSource: second._id });
  const rows = await report();
  expect(rows.find(r => r.sourceId === String(source._id))).toMatchObject({ totalCalls: 0, leads: 1, bookedJobs: 1, estimatedRevenue: 500, actualRevenue: 300 });
  expect(rows.find(r => r.sourceId === String(second._id))).toMatchObject({ totalCalls: 2, leads: 0, bookedJobs: 0, estimatedRevenue: 0, actualRevenue: 0, costPerLead: null, costPerBookedJob: null, roas: 0 });
});
test('legacy first source stays stable across date filters and deleted historical calls', async () => {
  const second = { ...source, _id: oid(), name: 'Second', nameKey: 'second' };
  await MarketingSource.collection.insertOne(second);
  await call({ createdAt: new Date('2026-09-01'), deletedAt: date });
  await call({ marketingSource: second._id });
  const rows = await report({ start: date.toISOString(), end: date.toISOString() });
  expect(rows.find(r => r.sourceId === String(source._id))).toMatchObject({ totalCalls: 0, bookedJobs: 1 });
  expect(rows.find(r => r.sourceId === String(second._id))).toMatchObject({ totalCalls: 1, bookedJobs: 0 });
});
test('archiving the first source preserves credit and historical call totals', async () => {
  await call();
  await MarketingSource.collection.updateOne({ _id: source._id }, { $set: { status: 'archived' } });
  expect((await report())[0]).toMatchObject({ sourceId: String(source._id), totalCalls: 1, bookedJobs: 1, actualRevenue: 300 });
});
test('empty archived sources remain hidden', async () => {
  await MarketingSource.collection.updateOne({ _id: source._id }, { $set: { status: 'archived' } });
  expect(await report()).toEqual([]);
});
test('foreign saved first source cannot receive credit or disclose source details', async () => {
  const foreign = { ...source, _id: oid(), business: oid(), name: 'Private', nameKey: 'private' };
  await MarketingSource.collection.insertOne(foreign);
  await Lead.collection.updateOne({ _id: lead }, { $set: { firstMarketingSource: foreign._id } });
  await call();
  const rows = await report();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sourceName: 'Search campaign', bookedJobs: 1 });
});
test('equal-time legacy calls use the lowest call ID regardless of insertion order', async () => {
  const second = { ...source, _id: oid(), name: 'Second', nameKey: 'second' };
  await MarketingSource.collection.insertOne(second);
  await call({ _id: new mongoose.Types.ObjectId('000000000000000000000002'), marketingSource: second._id });
  await call({ _id: new mongoose.Types.ObjectId('000000000000000000000001') });
  const rows = await report();
  expect(rows.find(r => r.sourceId === String(source._id)).bookedJobs).toBe(1);
  expect(rows.find(r => r.sourceId === String(second._id)).bookedJobs).toBe(0);
});


test('later SMS links only recent unassigned tracked calls for its business and phone, without claiming recovery', async () => {
  const now = new Date('2026-10-04T14:00:00Z');
  const answered = await call({ lead: null, disposition: 'answered_by_business', recovered: false });
  const excluded = await Promise.all([
    call({ lead: null, business: oid() }), call({ lead: null, from: '+14045550111' }),
    call({ lead: null, createdAt: new Date('2026-08-01') }), call({ lead: null, deletedAt: now }),
    call({ lead: null, trackingNumber: null }), call({ lead: oid() }),
  ]);
  const args = { businessId: business, leadId: lead, conversationId: conversation, phone: '(404) 555-0999', now };
  await linkRecentTrackedCalls(args); await linkRecentTrackedCalls(args);
  const saved = await CallLog.findById(answered._id).lean();
  expect(String(saved.lead)).toBe(String(lead)); expect(String(saved.conversation)).toBe(String(conversation));
  expect(saved.disposition).toBe('answered_by_business'); expect(saved.recovered).toBe(false);
  for (const row of excluded) expect(String((await CallLog.findById(row._id).lean()).lead)).toBe(String(row.lead));
  expect(String((await Lead.findById(lead).lean()).firstMarketingSource)).toBe(String(source._id));
});

test('linking preserves an existing direct first source even without a tracking number', async () => {
  const original = oid();
  await Lead.collection.updateOne({ _id: lead }, { $set: { firstMarketingSource: original } });
  await call({ lead: null });
  await linkRecentTrackedCalls({ businessId: business, leadId: lead, conversationId: conversation, phone: '+14045550999', now: new Date('2026-10-04') });
  expect(String((await Lead.findById(lead).lean()).firstMarketingSource)).toBe(String(original));
});

test('direct first-source lead contributes once without a call and respects its acquisition date', async () => {
  await Lead.collection.updateOne({ _id: lead }, { $set: { firstMarketingSource: source._id, createdAt: date } });
  const [row] = await report({ start: date.toISOString(), end: date.toISOString() });
  expect(row).toMatchObject({ totalCalls: 0, leads: 1, actualRevenue: 300 });
  expect((await report({ start: '2027-01-01', end: '2027-02-01' }))[0].actualRevenue).toBe(0);
  await call();
  expect((await report())[0]).toMatchObject({ totalCalls: 1, leads: 1, actualRevenue: 300 });
});
