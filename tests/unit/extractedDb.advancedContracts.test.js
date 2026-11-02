/** Trial redemption, intelligence query scoping, and dashboard aggregation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDbtrial1Methods } from '../../src/db/repositories/extracted/trial-1.js';
import { createDbintelligence1Methods } from '../../src/db/repositories/extracted/intelligence-1.js';
import { createDbreporting1Methods } from '../../src/db/repositories/extracted/reporting-1.js';

function queryRecorder(value = []) {
  const events = [];
  let query;
  query = new Proxy({}, { get(_t, name) {
    if (name === 'then') return (resolve, reject) => Promise.resolve(value).then(resolve, reject);
    return (...args) => { events.push([name, args]); return query; };
  }});
  const model = {
    find: (...args) => { events.push(['find', args]); return query; },
    findOne: (...args) => { events.push(['findOne', args]); return query; },
    findOneAndUpdate: (...args) => { events.push(['findOneAndUpdate', args]); return query; },
    countDocuments: async (...args) => { events.push(['countDocuments', args]); return 7; },
    aggregate: async (...args) => { events.push(['aggregate', args]); return value; },
  };
  return { model, events, query };
}

const noLogger = { error() {} };
const trial = createDbtrial1Methods({ safeConsole: noLogger });
const intel = createDbintelligence1Methods({
  CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS: 'status lastMessage',
  CONVERSATION_INTELLIGENCE_LEAD_FIELDS: 'status customerName',
});

for (const filters of [
  {},
  { ownerId: 'u1' },
  { emailKey: 'normalized@example.com' },
  { phoneKey: '+15551234567' },
  { ownerId: 'u1', emailKey: 'normalized@example.com', phoneKey: '+15551234567' },
]) {
  test(`trial redemption search preserves identity constraints ${JSON.stringify(filters)}`, async () => {
    const { model, events } = queryRecorder({ found: true });
    const response = await trial.findTrialRedemption(model, filters);
    if (!Object.keys(filters).length) {
      assert.equal(response, null, 'empty identity search must not access arbitrary redemption');
      assert.equal(events.length, 0);
    } else {
      assert.deepEqual(events[0], ['findOne', [{ $or: Object.entries(filters).map(([k,v]) =>
        ({ [k === 'ownerId' ? 'owner' : k]: v })) }]]);
      assert.ok(events.some(x => x[0] === 'lean'));
      assert.deepEqual(response, { found: true });
    }
  });
}

test('duplicate trial redemption surfaces duplicate classification and original error', async () => {
  const logged = [];
  const methods = createDbtrial1Methods({ safeConsole: { error: (...args) => logged.push(args) } });
  class DuplicateModel { constructor(data) { this.data = data; }
    async save() { const error = new Error('duplicate key'); error.code = 11000; throw error; }
  }
  await assert.rejects(() => methods.createTrialRedemption(DuplicateModel, { emailKey: 'one' }), error =>
    error.code === 11000 && error.isDuplicateTrial === true);
  assert.equal(logged.length, 1);
});

test('non-duplicate trial failure is not misclassified', async () => {
  class FailModel { async save() { throw new Error('connection failed'); } }
  await assert.rejects(() => trial.createTrialRedemption(FailModel, {}), error =>
    error.message === 'connection failed' && error.isDuplicateTrial === undefined);
});

test('successful trial redemption persists data exactly once', async () => {
  const calls = [];
  class Model { constructor(payload) { this.payload = payload; }
    async save() { calls.push(this.payload); return { id: 'saved' }; }
  }
  assert.deepEqual(await trial.createTrialRedemption(Model, { owner: 'u1' }), { id: 'saved' });
  assert.deepEqual(calls, [{ owner: 'u1' }]);
});

for (const config of [
  {},
  { status: 'completed', minimumScore: 0, urgency: 'high', actionCompleted: false, page: 3, limit: 10 },
  { minimumScore: 90, actionCompleted: true, page: 2, limit: 5 },
]) {
  test(`intelligence paged listing filters are tenant-scoped ${JSON.stringify(config)}`, async () => {
    const { model, events } = queryRecorder([{ id: 'analysis-1' }]);
    const out = await intel.getConversationIntelligenceByBusiness(model, 'tenant-one', config);
    const query = events.find(x => x[0] === 'find')[1][0];
    assert.equal(query.business, 'tenant-one');
    if (config.status) assert.equal(query.status, config.status);
    if (config.minimumScore !== undefined) assert.deepEqual(query['buyingLikelihood.score'], { $gte: config.minimumScore });
    if (config.actionCompleted !== undefined) assert.equal(query['nextBestAction.completed'], config.actionCompleted);
    if (config.urgency) assert.equal(query['urgency.level'], config.urgency);
    assert.deepEqual(events.find(x => x[0] === 'countDocuments')[1][0], query);
    assert.equal(out.pagination.total, 7);
    assert.equal(out.pagination.page, config.page || 1);
    assert.equal(out.pagination.limit, config.limit || 25);
    assert.equal(out.pagination.pages, Math.ceil(7 / (config.limit || 25)));
  });
}

for (const config of [
  {},
  { urgency: ['high','emergency'], actionCompleted: false, minimumScore: 0, minimumRevenue: 0, page: 3, limit: 4 },
  { urgency: [], actionCompleted: true, minimumScore: 90, minimumRevenue: 2000 },
]) {
  test(`intelligence opportunities apply revenue, consented action and urgency filters ${JSON.stringify(config)}`, async () => {
    const { model, events } = queryRecorder([{ id: 'opportunity-1' }]);
    const out = await intel.getConversationIntelligenceOpportunities(model, 'tenant-one', config);
    const query = events.find(x => x[0] === 'find')[1][0];
    assert.equal(query.business, 'tenant-one');
    assert.equal(query.status, 'completed');
    assert.deepEqual(query['buyingLikelihood.score'], { $gte: config.minimumScore ?? 70 });
    assert.deepEqual(query['estimatedRevenue.likely'], { $gte: config.minimumRevenue ?? 0 });
    if (config.urgency?.length) assert.deepEqual(query['urgency.level'], { $in: config.urgency });
    else assert.equal(query['urgency.level'], undefined);
    if (config.actionCompleted !== undefined) assert.equal(query['nextBestAction.completed'], config.actionCompleted);
    assert.deepEqual(events.find(x => x[0] === 'countDocuments')[1][0], query);
    assert.equal(out.pagination.total, 7);
  });
}

test('intelligence direct and tenant-scoped reads preserve conversation and lead projections', async () => {
  const { model, events } = queryRecorder({ _id: 'analysis-1' });
  await intel.getConversationIntelligenceByConversation(model, 'conversation-one');
  await intel.getConversationIntelligenceForBusinessByConversation(model, 'conversation-one', 'tenant-one');
  assert.deepEqual(events.filter(x => x[0] === 'findOne').map(x => x[1][0]), [
    { conversation: 'conversation-one' },
    { conversation: 'conversation-one', business: 'tenant-one' },
  ]);
  const projections = events.filter(x => x[0] === 'populate').map(x => x[1][0]);
  assert.ok(projections.some(x => x.path === 'lead' && x.select === 'status customerName'));
});

test('intelligence mutation commands retain tenant boundaries and validators', async () => {
  const { model, events } = queryRecorder({ _id: 'analysis-1' });
  await intel.saveConversationIntelligence(model, { conversation: 'c1', status: 'pending' });
  await intel.updateConversationIntelligence(model, 'c1', { status: 'completed' });
  await intel.updateConversationIntelligenceForBusiness(model, 'c1', 'tenant-one', { status: 'completed' });
  const updates = events.filter(x => x[0] === 'findOneAndUpdate').map(x => x[1]);
  assert.deepEqual(updates[0][0], { conversation: 'c1' });
  assert.equal(updates[0][2].upsert, true);
  assert.deepEqual(updates[2][0], { conversation: 'c1', business: 'tenant-one' });
  assert.ok(updates.every(x => x[2].runValidators === true));
});

test('intelligence dashboard returns zero metrics when no matching analyses exist', async () => {
  const { model, events } = queryRecorder([]);
  const out = await intel.getConversationIntelligenceDashboard(model, 'tenant-one');
  assert.equal(out.totalAnalyzed, 0);
  assert.equal(out.pendingActions, 0);
  assert.deepEqual(events[0][1][0][0].$match, { business: 'tenant-one', status: 'completed' });
});

test('intelligence dashboard preserves actual aggregation totals', async () => {
  const expected = { totalAnalyzed: 4, pendingActions: 2 };
  const { model } = queryRecorder([expected]);
  assert.equal(await intel.getConversationIntelligenceDashboard(model, 'tenant-one'), expected);
});

test('dashboard metrics never return another tenant when business lookup misses', async () => {
  const events = [];
  const q = { select: () => q, lean: async () => null };
  const data = { Business: { findOne: x => { events.push(x); return q; } },
    CallLog: {}, Lead: {}, Conversation: {}, Message: {}, ownerId: 'owner-one', businessId: 'tenant-one' };
  const metrics = createDbreporting1Methods({ safeConsole: noLogger, verifiedAmountExpression: '$valuation' });
  assert.equal(await metrics.getDashboardMetrics(data), null);
  assert.deepEqual(events, [{ _id: 'tenant-one', owner: 'owner-one' }]);
});

test('dashboard aggregate errors are surfaced, never replaced with fabricated zero metrics', async () => {
  const error = new Error('MongoDB offline');
  const logged = [];
  const metrics = createDbreporting1Methods({ safeConsole: { error: (...x) => logged.push(x) }, verifiedAmountExpression: '$valuation' });
  const data = { Business: { findOne: () => { throw error; } },
    CallLog: {}, Lead: {}, Conversation: {}, Message: {}, ownerId: 'owner-one' };
  await assert.rejects(() => metrics.getDashboardMetrics(data), err => err === error);
  assert.equal(logged.length, 1);
});

test('business-deletion adapter resolves the actual service path after extraction', () => {
  const modulePath = path.join(process.cwd(), 'src/db/repositories/extracted/business-1.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  assert.match(source, /import\(\s*["']\.\.\/\.\.\/\.\.\/services\/businessDeletion\.service\.js["']\s*\)/);
  const target = path.join(process.cwd(), 'src/services/businessDeletion.service.js');
  assert.ok(fs.existsSync(target), 'extracted deletion must resolve the production business deletion service');
});
