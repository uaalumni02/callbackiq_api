import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import Lead from '../../src/models/lead.js';
import { closeTestDB, connectTestDB } from '../setup/testDb.js';

const run = promisify(execFile);
let uri;
beforeAll(async () => { uri = await connectTestDB(); }, 60000);
afterAll(closeTestDB);

const migrate = (...args) => run(process.execPath, ['scripts/migrate-required-indexes.mjs', ...args], {
  env: { ...process.env, MONGODB_URI: uri, MONGO_URL: uri, MONGO_URI: uri }, timeout: 45000,
});

test('release data check detects missing indexes and historical projections until the same rollout applies both', async () => {
  const business = new mongoose.Types.ObjectId();
  const lead = await Lead.collection.insertOne({ business, status: 'new', updatedAt: new Date() });
  const collections = async () => (await mongoose.connection.db.listCollections({}, { nameOnly: true })
    .toArray()).map(collection => collection.name).sort();
  const before = await collections();
  await expect(migrate('--check')).rejects.toMatchObject({ code: 2 });
  expect(await collections()).toEqual(before);
  await migrate('--apply');
  const first = await Lead.collection.findOne({ _id: lead.insertedId, business });
  expect(first.workflowFlags).toEqual(expect.objectContaining({
    ready: expect.any(Boolean), needsMe: expect.any(Boolean), waiting: expect.any(Boolean), computedAt: expect.any(Date),
  }));
  await migrate('--check');
  await migrate('--apply');
  const repeated = await Lead.collection.findOne({ _id: lead.insertedId, business });
  expect(repeated.workflowFlags).toEqual(first.workflowFlags);

  await Lead.collection.updateOne({ _id: lead.insertedId, business }, { $unset: { workflowFlags: '' } });
  await expect(migrate('--check')).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Lead workflow backfill') });
  expect((await Lead.collection.findOne({ _id: lead.insertedId, business })).workflowFlags).toBeUndefined();
  await migrate('--apply');

  await Lead.collection.dropIndex('workflowFlagsPending_1__id_1');
  await expect(migrate('--check')).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('MISSING leads') });
  await migrate('--apply');
  await migrate('--check');
}, 100000);
