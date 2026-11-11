import request from 'supertest';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import CallLog from '../../src/models/callLog.js';
import Subscription from '../../src/models/subscription.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);

async function owner(number) {
  const response = await request(app).post('/api/auth/register').send({
    userName: `tenantowner${number}`, email: `tenantowner${number}@example.com`, password: 'Synthetic123!',
    businessName: `Synthetic Plumbing ${number}`, businessPhone: `404555012${number}`, businessType: 'plumbing',
    smsConsent: true, termsAccepted: true, privacyAccepted: true,
  });
  expect(response.status).toBe(201);
  const { token, business: { _id: business } } = response.body.data;
  await Business.updateOne({ _id: business }, { $set: { isActive: true } });
  await Subscription.findOneAndUpdate({ business }, { business, stripeCustomerId: `cus_tenant_${number}`,
    stripeSubscriptionId: `sub_tenant_${number}`, status: 'active', isActive: true, aiEnabled: true }, { upsert: true });
  return { business, headers: { Authorization: `Bearer ${token}` } };
}

async function tenants() {
  const a = await owner(1), b = await owner(2);
  const foreign = await Lead.create({ business: b.business, customerName: 'Foreign customer',
    phone: '+14045550124', serviceNeeded: 'Foreign plumbing request' });
  const conversation = await Conversation.create({ business: a.business, customerPhone: '+14045550125' });
  return { a, b, foreign, conversation };
}

test('a foreign lead cannot be attached or exposed through conversation create/update', async () => {
  const { a, foreign, conversation } = await tenants();
  expect((await request(app).get(`/api/leads/${foreign.id}`).set(a.headers)).status).toBe(401);
  const update = await request(app).patch(`/api/conversations/${conversation.id}`).set(a.headers).send({ lead: foreign.id });
  expect(update.status).toBe(400);
  const create = await request(app).post('/api/conversations').set(a.headers).send({
    business: a.business, customerPhone: '+14045550126', lead: foreign.id,
  });
  expect(create.status).toBe(400);
  expect((await Conversation.findById(conversation.id)).lead).toBeUndefined();
});

test.each([body => ({ business: body }), body => ({ $set: { business: body } }),
  body => ({ 'business._id': body }), body => ({ $rename: { business: body } }),
])('owner mutations reject tenant reassignment and Mongo operators', async build => {
  const { a, b, conversation } = await tenants();
  const response = await request(app).patch(`/api/conversations/${conversation.id}`).set(a.headers).send(build(b.business));
  expect(response.status).toBe(400);
  expect(String((await Conversation.findById(conversation.id)).business)).toBe(a.business);
});

test('call create and partial update validate referenced tenants and keep ownership', async () => {
  const { a, b, foreign, conversation } = await tenants();
  const call = await CallLog.create({ business: a.business, from: '+14045550125', to: '+14045550121', durationSeconds: 42, recovered: true });
  for (const body of [{ business: b.business }, { lead: foreign.id }, { conversation: foreign.id }, { $set: { business: b.business } }, { 'lead.business': b.business }]) {
    const response = await request(app).patch(`/api/calls/${call.id}`).set(a.headers).send(body);
    expect(response.status).toBe(400);
  }
  const create = await request(app).post('/api/calls').set(a.headers).send({ business: a.business,
    lead: foreign.id, from: '+14045550125', to: '+14045550121', durationSeconds: 42, recovered: true });
  expect(create.status).toBe(400);
  const valid = await request(app).patch(`/api/calls/${call.id}`).set(a.headers).send({ notes: 'Reviewed', conversation: conversation.id });
  expect(valid.status).toBe(200);
  expect(String((await CallLog.findById(call.id)).business)).toBe(a.business);
  expect(await CallLog.findById(call.id)).toMatchObject({ durationSeconds: 42, recovered: true });
});

test('historical corrupt references are omitted from direct and paginated owner reads', async () => {
  const { a, foreign, conversation } = await tenants();
  await Conversation.collection.updateOne({ _id: conversation._id }, { $set: { lead: foreign._id } });
  const direct = await request(app).get(`/api/conversations/${conversation.id}`).set(a.headers);
  expect(direct.status).toBe(200);
  expect(direct.body.data.lead).toBeNull();
  const page = await request(app).get('/api/conversations?search=14045550125').set(a.headers);
  expect(page.status).toBe(200);
  expect(JSON.stringify(page.body)).not.toContain('Foreign customer');
});
