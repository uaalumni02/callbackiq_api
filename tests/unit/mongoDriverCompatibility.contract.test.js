import mongoose from 'mongoose';
import { BSON } from 'mongodb';

test('the installed driver preserves required BSON handshake metadata in Jest', async () => {
  const document = new Map([['driver', { name: 'nodejs', version: 'test' }]]);
  expect(BSON.deserialize(BSON.serialize(document))).toEqual({ driver: { name: 'nodejs', version: 'test' } });
  const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:1');
  expect(await client.options.metadata).toHaveProperty('driver.name', 'nodejs');
  expect((await client.options.runtime).os.platform()).toBe(process.platform);
  await client.close();
});
