import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.RESTORE_MONGODB_URI;

if (!uri) {
  console.error("RESTORE_MONGODB_URI is required.");
  process.exit(1);
}

const EXPECTED_COLLECTIONS = [
  "businesses",
  "users",
  "subscriptions",
  "leads",
  "conversations",
  "messages",
  "calllogs",
  "alerts",
];

try {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  const database = mongoose.connection.db;
  const existing = new Set(
    (await database.listCollections().toArray()).map((entry) => entry.name),
  );

  const missing = EXPECTED_COLLECTIONS.filter((name) => !existing.has(name));
  const counts = {};

  for (const name of EXPECTED_COLLECTIONS.filter((item) => existing.has(item))) {
    counts[name] = await database.collection(name).estimatedDocumentCount();
  }

  console.log(
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        database: database.databaseName,
        missingCollections: missing,
        collectionCounts: counts,
      },
      null,
      2,
    ),
  );

  if (missing.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await mongoose.disconnect();
}
