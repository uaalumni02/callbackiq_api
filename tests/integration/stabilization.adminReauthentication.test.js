import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.js';
import Token from '../../src/helpers/jwt/token.js';
import Conversation from '../../src/models/conversation.js';
import { stabilizationFixture } from '../setup/stabilizationFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
beforeAll(connectTestDB); afterEach(clearTestDB); afterAll(closeTestDB);
test('cross-business conversation archive, restore and delete require the same fresh MFA session as administrator writes', async () => {
  const f = await stabilizationFixture();
  const admin = await User.create({ userName: 'StabilizationAdmin', email: 'admin-stabilization@example.test', password: 'synthetic-hash', role: 'admin', businessName: 'Synthetic admin' });
  const token = age => Token.sign({ userId: String(admin._id), role: 'admin', sessionVersion: 0, mfaVerified: true, authTime: Math.floor(Date.now() / 1000) - age });
  for (const path of ['archive', 'restore']) {
    const result = await request(app).post(`/api/conversations/${f.conversation._id}/${path}`).set('Authorization', `Bearer ${token(3600)}`).send({});
    expect(result.status).toBe(401); expect(result.body.code).toBe('ADMIN_REAUTH_REQUIRED');
  }
  expect((await request(app).delete(`/api/conversations/${f.conversation._id}`).set('Authorization', `Bearer ${token(3600)}`)).status).toBe(401);
  expect(await Conversation.findById(f.conversation._id)).toBeTruthy();
  expect((await request(app).post(`/api/conversations/${f.conversation._id}/archive`).set('Authorization', `Bearer ${token(0)}`).send({})).status).toBe(200);
});
