import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../src/app.js';
import VoiceSession from '../../src/models/voiceSession.js';
import VoiceUsageLedger from '../../src/models/voiceUsageLedger.js';
import { stabilizationFixture } from '../setup/stabilizationFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
beforeAll(connectTestDB); afterEach(clearTestDB); afterAll(closeTestDB);
test('voice HTTP operations bind the owned business and every tenant schema rejects null/undefined filters', async () => {
  const a = await stabilizationFixture(), b = await stabilizationFixture();
  const foreign = await VoiceSession.create({ business: b.business._id, providerCallSid: 'CAforeign', outcome: 'booked', startedAt: new Date() });
  await VoiceUsageLedger.create({ business: b.business._id, periodType: 'month', periodKey: new Date().toISOString().slice(0, 7) });
  const metrics = await request(app).get('/api/voice-operations/metrics').set('Authorization', `Bearer ${a.token}`);
  expect(metrics.status).toBe(200); expect(metrics.body.data.totalCalls).toBe(0);
  const usage = await request(app).get('/api/voice-operations/usage').set('Authorization', `Bearer ${a.token}`);
  expect(usage.status).toBe(200); expect(usage.body.data.month).toBeNull();
  const review = await request(app).post('/api/voice-operations/metrics/emergency-review').set('Authorization', `Bearer ${a.token}`).send({ sessionId: String(foreign._id), classification: 'correct' });
  expect(review.status).toBe(404);
  const Model = mongoose.model('StabilizationTenantGuard', new mongoose.Schema({ business: mongoose.Schema.Types.ObjectId, value: String }));
  for (const business of [null, undefined]) {
    const queries = [Model.find({ business }), Model.findOne({ business }), Model.countDocuments({ business }),
      Model.updateOne({ business }, { $set: { value: 'unsafe' } }), Model.updateMany({ business }, { $set: { value: 'unsafe' } }),
      Model.deleteOne({ business }), Model.deleteMany({ business }), Model.findOneAndUpdate({ business }, { $set: { value: 'unsafe' } }),
      Model.aggregate([{ $match: { business } }]), Model.find({ $or: [{ business }, { value: 'unsafe' }] })];
    for (const query of queries) await expect(query.exec()).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
  }
  // Explicit trusted infrastructure option is consumed before reaching the driver.
  await expect(Model.find({ business: null }).setOptions({ allowCrossTenant: true }).exec()).resolves.toEqual([]);
  await expect(Model.aggregate([{ $match: { business: null } }]).option({ allowCrossTenant: true }).exec()).resolves.toEqual([]);
});
