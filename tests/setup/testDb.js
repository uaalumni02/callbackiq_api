import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongoServer;

const connectTestDB = async () => {
  // Own the instance before starting it so partial startup can be cleaned up.
  mongoServer = new MongoMemoryServer({ instance: { launchTimeout: 30000 } });
  try {
    await mongoServer.start();
    await mongoose.connect(mongoServer.getUri(), { serverSelectionTimeoutMS: 15000 });
    return mongoServer.getUri();
  } catch (error) {
    // Preserve the startup error; cleanup must not replace it or buffer queries.
    try { if (mongoose.connection.readyState !== 0) await mongoose.connection.close(); } catch {}
    try { await mongoServer.stop(); } catch {}
    mongoServer = undefined;
    throw error;
  }
};

const clearTestDB = async () => {
  if (mongoose.connection.readyState !== 1) return;
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
};

const closeTestDB = async () => {
  const owned = mongoServer;
  mongoServer = undefined;
  try {
    if (owned && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    try {
      if (owned && mongoose.connection.readyState !== 0) await mongoose.connection.close();
    } finally {
      await owned?.stop();
    }
  }
};

export { connectTestDB, clearTestDB, closeTestDB };
