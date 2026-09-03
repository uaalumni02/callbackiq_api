#!/usr/bin/env node

// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1
// Creates or verifies the MongoDB indexes required by the production SMS handoff flow.

import process from "node:process";
import mongoose from "mongoose";

if (!process.env.MONGO_URL) {
  throw new Error("MONGO_URL is missing.");
}

const normalizeKey = (key = {}) =>
  JSON.stringify(Object.entries(key).map(([field, direction]) => [field, Number(direction)]));

const findEquivalentIndex = (indexes, key) => {
  const target = normalizeKey(key);
  return indexes.find((index) => normalizeKey(index.key) === target) || null;
};

const ensureIndex = async ({
  collection,
  key,
  name,
  unique = false,
  partialFilterExpression,
}) => {
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
  }
  const existing = findEquivalentIndex(indexes, key);

  if (existing) {
    if (unique && existing.unique !== true) {
      throw new Error(
        `${collection.collectionName}.${existing.name} has the required key but is not unique. Review it manually before deployment.`,
      );
    }
    console.log(`PASS  ${collection.collectionName}.${existing.name} already covers ${name}`);
    return existing.name;
  }

  const created = await collection.createIndex(key, {
    name,
    unique,
    ...(partialFilterExpression ? { partialFilterExpression } : {}),
    background: true,
  });
  console.log(`PASS  Created ${collection.collectionName}.${created}`);
  return created;
};

await mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection.db;

try {
  const messages = db.collection("messages");
  const duplicateReplies = await messages
    .aggregate([
      {
        $match: {
          inReplyToMessage: { $type: "objectId" },
        },
      },
      {
        $group: {
          _id: {
            business: "$business",
            inReplyToMessage: "$inReplyToMessage",
          },
          count: { $sum: 1 },
          messageIds: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ])
    .toArray();

  if (duplicateReplies.length) {
    console.error("FAIL  Duplicate outbound replies exist for the same inbound message:");
    for (const duplicate of duplicateReplies) {
      console.error(
        `  business=${duplicate._id.business} inbound=${duplicate._id.inReplyToMessage} count=${duplicate.count} messages=${duplicate.messageIds.join(",")}`,
      );
    }
    throw new Error(
      "Resolve duplicate inReplyToMessage records before creating the unique SMS idempotency index.",
    );
  }

  console.log("PASS  No duplicate outbound replies were found");

  await ensureIndex({
    collection: messages,
    key: { business: 1, inReplyToMessage: 1 },
    name: "message_business_inbound_reply_unique",
    unique: true,
    partialFilterExpression: { inReplyToMessage: { $type: "objectId" } },
  });

  await ensureIndex({
    collection: db.collection("smsprocessingjobs"),
    key: { inboundMessage: 1 },
    name: "sms_processing_inbound_unique",
    unique: true,
  });

  await ensureIndex({
    collection: db.collection("alerts"),
    key: { business: 1, dedupeKey: 1 },
    name: "alert_business_dedupe_unique",
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  });

  await ensureIndex({
    collection: db.collection("conversations"),
    key: {
      "orchestration.handoffStatus": 1,
      "orchestration.handoffRequestedAt": 1,
    },
    name: "conversation_sms_handoff_lifecycle",
  });

  console.log("\nSMS handoff indexes are ready.");
} finally {
  await mongoose.disconnect();
}
