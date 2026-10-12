import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Exercise real MongoDB return values; mocks cannot detect an accidental switch
// from the claimed/updated document back to its pre-update state.
let server;
let isolated;
let Record;
let warning;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  isolated = new mongoose.Mongoose();
  await isolated.connect(server.getUri());
  Record = isolated.model('ReturnDocumentRecord', new isolated.Schema({
    business: { type: String, required: true },
    key: { type: String, required: true },
    count: { type: Number, min: 0, default: 0 },
    status: { type: String, default: 'pending' },
    availableAt: Date,
    lockedBy: String,
  }));
}, 60000);

beforeEach(async () => {
  await Record.deleteMany({});
  warning = jest.spyOn(process, 'emitWarning');
});

afterEach(() => {
  if (!warning) return;
  const deprecations = warning.mock.calls.filter(([message]) =>
    /mongoose: the `(new|returnOriginal)` option/.test(String(message)),
  );
  warning.mockRestore();
  expect(deprecations).toHaveLength(0);
});

afterAll(async () => {
  await isolated?.disconnect();
  await server?.stop();
});

test('an update returns the stored post-update values and keeps the tenant filter', async () => {
  const original = await Record.create({ business: 'tenant-a', key: 'usage', count: 2 });
  await Record.create({ business: 'tenant-b', key: 'usage', count: 9 });
  const updated = await Record.findOneAndUpdate(
    { business: 'tenant-a', key: 'usage' },
    { $inc: { count: 1 } },
    { returnDocument: 'after', runValidators: true },
  );
  expect(String(updated._id)).toBe(String(original._id));
  expect(updated.count).toBe(3);
  expect((await Record.findById(original._id)).count).toBe(3);
  expect((await Record.findOne({ business: 'tenant-b' })).count).toBe(9);
});

test('findByIdAndUpdate returns a hydrated updated document', async () => {
  const original = await Record.create({ business: 'tenant-a', key: 'appointment' });
  const updated = await Record.findByIdAndUpdate(
    original._id, { $set: { status: 'confirmed' } }, { returnDocument: 'after' },
  );
  expect(updated).toBeInstanceOf(Record);
  expect(updated.status).toBe('confirmed');
});

test('an upsert returns the inserted document with defaults and remains idempotent', async () => {
  const filter = { business: 'tenant-a', key: 'confirmation-notice' };
  const update = { $setOnInsert: { status: 'queued' } };
  const options = { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true };
  const first = await Record.findOneAndUpdate(filter, update, options);
  const replay = await Record.findOneAndUpdate(filter, update, options);
  expect(first.status).toBe('queued');
  expect(first.count).toBe(0);
  expect(String(replay._id)).toBe(String(first._id));
  expect(await Record.countDocuments(filter)).toBe(1);
});

test('sorted competing worker claims return distinct documents in the claimed state', async () => {
  await Record.create([
    { business: 'tenant-a', key: 'first', availableAt: new Date(0) },
    { business: 'tenant-a', key: 'second', availableAt: new Date(1) },
  ]);
  const claim = lockedBy => Record.findOneAndUpdate(
    { business: 'tenant-a', status: 'pending' },
    { $set: { status: 'processing', lockedBy }, $inc: { count: 1 } },
    { sort: { availableAt: 1 }, returnDocument: 'after' },
  );
  const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')]);
  expect(new Set([first.key, second.key])).toEqual(new Set(['first', 'second']));
  expect(first).toMatchObject({ status: 'processing', lockedBy: 'worker-a', count: 1 });
  expect(second).toMatchObject({ status: 'processing', lockedBy: 'worker-b', count: 1 });
  expect(await claim('worker-c')).toBeNull();
});

test('validators still reject invalid values without changing the stored record', async () => {
  const original = await Record.create({ business: 'tenant-a', key: 'usage', count: 4 });
  await expect(Record.findByIdAndUpdate(
    original._id, { $set: { count: -1 } }, { returnDocument: 'after', runValidators: true },
  )).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
  expect((await Record.findById(original._id)).count).toBe(4);
});

test('lean queries return plain post-update data and preserve a provided session', async () => {
  const original = await Record.create({ business: 'tenant-a', key: 'lean' });
  const session = await isolated.startSession();
  try {
    const updated = await Record.findByIdAndUpdate(
      original._id, { $set: { status: 'sent' } }, { returnDocument: 'after', session },
    ).lean();
    expect(updated).not.toBeInstanceOf(Record);
    expect(updated.status).toBe('sent');
    expect((await Record.findById(original._id)).status).toBe('sent');
  } finally { await session.endSession(); }
});

test('replacement queries return the replacement document', async () => {
  await Record.create({ business: 'tenant-a', key: 'replace', count: 1 });
  const replacement = await Record.findOneAndReplace(
    { business: 'tenant-a', key: 'replace' },
    { business: 'tenant-a', key: 'replace', count: 7, status: 'completed' },
    { returnDocument: 'after', runValidators: true },
  );
  expect(replacement).toMatchObject({ count: 7, status: 'completed' });
});

test('queries without a return option retain the original before-update default', async () => {
  const original = await Record.create({ business: 'tenant-a', key: 'default', count: 1 });
  const before = await Record.findByIdAndUpdate(original._id, { $inc: { count: 1 } });
  expect(before.count).toBe(1);
  expect((await Record.findById(original._id)).count).toBe(2);
});
