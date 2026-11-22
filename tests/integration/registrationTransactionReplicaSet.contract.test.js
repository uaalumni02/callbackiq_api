import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import VoiceSettingsVersion from '../../src/models/voiceSettingsVersion.js';
import { publishVoiceSettingsVersion, rollbackVoiceSettingsVersion } from '../../src/services/voiceSettingsVersion.service.js';
import { runRegistrationTransaction } from '../../src/services/registrationTransaction.service.js';

let replica;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all([User.init(),Business.init(),VoiceSettingsVersion.init()]);
}, 60000);
afterEach(async () => { await User.deleteMany({}); await Business.deleteMany({}); await VoiceSettingsVersion.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
async function persist(session) {
  const [user] = await User.create([{ userName: 'atomicowner', email: 'atomic@example.com', businessName: 'Atomic Plumbing', password: 'synthetic-hash' }], { session });
  await Business.create([{ owner: user._id, businessName: 'Atomic Plumbing', businessType: 'plumbing' }], { session });
}
test('registration rollback leaves neither an owner nor business after a later persistence failure', async () => {
  await expect(runRegistrationTransaction(async session => { await persist(session); throw new Error('Synthetic registration failure'); },
    { env: { NODE_ENV: 'production' } })).rejects.toThrow('Synthetic registration failure');
  expect(await User.countDocuments()).toBe(0); expect(await Business.countDocuments()).toBe(0);
});
test('registration success commits both owner and business through the real transaction boundary', async () => {
  await runRegistrationTransaction(persist, { env: { NODE_ENV: 'production' } });
  const user = await User.findOne({ userName: 'atomicowner' }); expect(user).not.toBeNull();
  expect(await Business.countDocuments({ owner: user._id })).toBe(1);
});
test('voice settings publication and rollback commit matching business and version records', async () => {
  const business = await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Versioned Plumbing', businessType: 'plumbing', features: { voiceAiEnabled: false } });
  const first = await publishVoiceSettingsVersion({ business });
  business.features.voiceAiEnabled = true; const second = await publishVoiceSettingsVersion({ business });
  expect(second.version).toBe(first.version+1); expect((await Business.findById(business._id)).features.voiceAiEnabled).toBe(true);
  await rollbackVoiceSettingsVersion({ business, version: first.version });
  const stored = await Business.findById(business._id), latest = await VoiceSettingsVersion.findOne({ business: business._id }).sort({ version: -1 });
  expect(stored.features.voiceAiEnabled).toBe(false); expect(latest.settings.features.voiceAiEnabled).toBe(false);
  expect(latest.rolledBackFromVersion).toBe(first.version);
});


test('a conflicting phone claim rolls back the newly created owner in production', async () => {
  await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Existing', forwardingPhone: '+14045551234' });
  await expect(runRegistrationTransaction(async session => {
    const [user] = await User.create([{ userName: 'phoneclaim', email: 'claim@example.com', businessName: 'New Business', password: 'synthetic-hash' }], { session });
    await Business.create([{ owner: user._id, businessName: 'New Business', forwardingPhone: '(404) 555-1234' }], { session });
  }, { env: { NODE_ENV: 'production' } })).rejects.toMatchObject({ code: 11000 });
  expect(await User.countDocuments({ email: 'claim@example.com' })).toBe(0);
  expect(await Business.countDocuments({ businessName: 'New Business' })).toBe(0);
});
