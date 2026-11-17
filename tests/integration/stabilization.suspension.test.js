import request from 'supertest';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
import { stabilizationFixture } from '../setup/stabilizationFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
beforeAll(connectTestDB); afterEach(clearTestDB); afterAll(closeTestDB);
test('the authentication boundary denies every suspended customer router while auth, billing recovery and support remain reachable', async () => {
  const f = await stabilizationFixture();
  await Business.updateOne({ _id: f.business._id }, { $set: { isActive: false } });
  const headers = { Authorization: `Bearer ${f.token}` };
  for (const route of ['/calls', '/leads', '/conversations', '/voice-operations/metrics', '/business-configuration', '/integrations/google/status', '/appointments', '/owner/dashboard']) {
    const result = await request(app).get(`/api${route}`).set(headers);
    expect(result.status).toBe(403);
  }
  const change = await request(app).patch(`/api/conversations/${f.conversation._id}`).set(headers).send({ customerName: 'Forbidden after suspension' });
  expect(change.status).toBe(403);
  expect((await Conversation.findById(f.conversation._id)).customerName).not.toBe('Forbidden after suspension');
  expect((await request(app).patch('/api/businesses/mine').set(headers).send({ businessName: 'Blocked' })).status).toBe(403);
  expect((await request(app).post('/api/businesses/mine/phone-verification/start').set(headers).send({})).status).toBe(403);
  expect((await request(app).get('/api/auth/me').set(headers)).status).toBe(200);
  expect((await request(app).get('/api/billing/access').set(headers)).status).toBe(200);
  expect((await request(app).get('/api/support/tickets').set(headers)).status).toBe(200);
});
