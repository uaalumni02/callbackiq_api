import request from 'supertest';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import app from '../../src/app.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
import Subscription from '../../src/models/subscription.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

let uri;
beforeAll(async () => { uri = await connectTestDB(); }, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
const child = (code, env) => new Promise((resolve, reject) => {
  const process = spawn(global.process.execPath, ['--input-type=module', '-e', code],
    { env: { ...global.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => { process.kill(); reject(new Error(`Child timeout: ${output}`)); }, 20000);
  process.on('error', reject);
  process.on('close', status => { clearTimeout(timer); resolve({ status, output }); });
});
async function owner() {
  const response = await request(app).post('/api/auth/register').send({
    userName: 'securityowner', email: 'security@example.com', password: 'Synthetic123!Passphrase',
    businessName: 'Synthetic Plumbing', businessPhone: '4045550121', businessType: 'plumbing',
    smsConsent: true, termsAccepted: true, privacyAccepted: true,
  });
  expect(response.status).toBe(201); return response.body.data;
}
test('production login sets a secure cookie and never returns a bearer token even with an enabling flag', async () => {
  await owner();
  const result = await child(`
    import mongoose from 'mongoose'; import request from 'supertest'; import assert from 'node:assert/strict';
    import app from './src/app.js';
    await mongoose.connect(process.env.MONGODB_URI);
    try {
      const response = await request(app).post('/api/auth/login').send({login:'security@example.com',password:'Synthetic123!Passphrase'});
      assert.equal(response.status,200,JSON.stringify(response.body)); assert.equal(response.body.data.token,undefined);
      assert.match(response.headers['set-cookie'].join(';'),/HttpOnly/); assert.match(response.headers['set-cookie'].join(';'),/Secure/);
      console.log('PRODUCTION_AUTH_CONTRACT_PASS');
    } finally { await mongoose.disconnect(); }
  `, { NODE_ENV: 'production', MONGODB_URI: uri, AUTH_RESPONSE_TOKEN_ENABLED: 'true', JWT_SECRET: 'test_secret_key' });
  expect(result.status).toBe(0); expect(result.output).toContain('PRODUCTION_AUTH_CONTRACT_PASS');
}, 30000);
test('a stale admin JWT cannot read a foreign conversation after database demotion', async () => {
  const data = await owner();
  const other = await Business.create({ owner: new User()._id, businessName: 'Foreign plumbing', businessType: 'plumbing' });
  const foreign = await Conversation.create({ business: other._id, customerPhone: '+14045550129' });
  await Business.updateOne({ _id: data.business._id }, { $set: { isActive: true } });
  const own = await Conversation.create({ business: data.business._id, customerPhone: '+14045550128' });
  await Subscription.updateOne({ business: data.business._id }, { $set: { status: 'active', isActive: true, aiEnabled: true } });
  await User.updateOne({ _id: data.user._id }, { $set: { role: 'owner' } });
  const token = jwt.sign({ userId: data.user._id, role: 'admin', sessionVersion: 0 }, process.env.JWT_SECRET);
  expect((await request(app).get(`/api/conversations/${own.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
  const response = await request(app).get(`/api/conversations/${foreign.id}`).set('Authorization', `Bearer ${token}`);
  expect([401,403,404]).toContain(response.status);
  expect(await Conversation.countDocuments({ _id: foreign._id })).toBe(1);
});
test('invalid startup configuration fails before Mongo connection attempts', async () => {
  const result = await child("await import('./src/server.js');", {
    NODE_ENV: 'production', JWT_SECRET: '', MONGODB_URI: 'mongodb://127.0.0.1:1/never-connect',
    MONGO_URL: '', MONGO_URI: '', DOTENV_CONFIG_PATH: '/dev/null',
  });
  expect(result.status).not.toBe(0); expect(result.output).toContain('INVALID_ENVIRONMENT');
  expect(result.output).not.toMatch(/ECONNREFUSED|MongoServerSelectionError/);
}, 30000);
