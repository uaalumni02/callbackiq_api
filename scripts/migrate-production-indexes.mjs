// CALLBACKIQ_PRODUCTION_HARDENING_V1
import mongoose from "mongoose";
import "dotenv/config";
import connectDB from "../src/db/connection.js";
import {
  normalizeRuntimeEnvironment,
} from "../src/config/runtime-environment.js";
import Lead from "../src/models/lead.js";
import Conversation from "../src/models/conversation.js";
import Message from "../src/models/message.js";
import RequestRateLimitBucket from "../src/models/requestRateLimitBucket.js";
import ProductionOperationLease from "../src/models/productionOperationLease.js";

const dryRun = process.argv.includes("--dry-run");

const definitions = [
  {
    model: Lead,
    key: { business: 1, createdAt: -1, _id: -1 },
    options: { name: "business_created_at_id_cursor" },
  },
  {
    model: Conversation,
    key: { business: 1, lastMessageAt: -1, createdAt: -1, _id: -1 },
    options: { name: "business_last_message_created_id_cursor" },
  },
  {
    model: Message,
    key: { conversation: 1, createdAt: 1, _id: 1 },
    options: { name: "conversation_created_at_id_cursor" },
  },
  {
    model: RequestRateLimitBucket,
    key: { expiresAt: 1 },
    options: { name: "expires_at_ttl", expireAfterSeconds: 0 },
  },
  {
    model: ProductionOperationLease,
    key: { expiresAt: 1 },
    options: { name: "expires_at_ttl", expireAfterSeconds: 0 },
  },
];

const optionalDefinitions = async () => {
  const result = [];
  try {
    const { default: A2pCustomerRegistration } = await import(
      "../src/models/a2pCustomerRegistration.js"
    );
    result.push({
      model: A2pCustomerRegistration,
      key: { status: 1, lastSyncedAt: 1, _id: 1 },
      options: { name: "status_last_synced_id_reconciliation" },
    });
  } catch (error) {
    console.warn(
      "Skipping optional A2P reconciliation index:",
      error?.message || String(error),
    );
  }
  return result;
};

const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left || {})) ===
  JSON.stringify(Object.entries(right || {}));

const inspectOrApply = async ({ model, key, options }) => {
  let existing = [];
  try {
    existing = await model.collection.indexes();
  } catch (error) {
    if (Number(error?.code) !== 26) throw error;
  }

  const match = existing.find(
    (index) => index.name === options.name || sameKey(index.key, key),
  );

  if (match) {
    console.log(`INDEX OK ${model.collection.collectionName}:${match.name}`);
    return;
  }

  if (dryRun) {
    console.log(
      `INDEX MISSING ${model.collection.collectionName}:${options.name}`,
      JSON.stringify(key),
    );
    process.exitCode = 2;
    return;
  }

  const name = await model.collection.createIndex(key, options);
  console.log(`INDEX CREATED ${model.collection.collectionName}:${name}`);
};

normalizeRuntimeEnvironment();
await connectDB();

try {
  const allDefinitions = [...definitions, ...(await optionalDefinitions())];
  for (const definition of allDefinitions) {
    await inspectOrApply(definition);
  }
} finally {
  await mongoose.connection.close();
}
