#!/usr/bin/env node
import process from "node:process";
import mongoose from "mongoose";

if (!process.env.MONGO_URL) {
  throw new Error("MONGO_URL is required.");
}

const normalizeKey = (key = {}) =>
  JSON.stringify(
    Object.entries(key).map(([field, direction]) => [
      field,
      Number(direction),
    ]),
  );

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
    if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") {
      throw error;
    }
  }

  const target = normalizeKey(key);
  const existing = indexes.find(
    (index) => normalizeKey(index.key) === target,
  );

  if (existing) {
    if (unique && existing.unique !== true) {
      throw new Error(
        `${collection.collectionName}.${existing.name} has the required key but is not unique.`,
      );
    }
    console.log(
      `PASS  ${collection.collectionName}.${existing.name} covers ${name}`,
    );
    return;
  }

  const created = await collection.createIndex(key, {
    name,
    unique,
    ...(partialFilterExpression
      ? { partialFilterExpression }
      : {}),
  });
  console.log(
    `PASS  Created ${collection.collectionName}.${created}`,
  );
};

await mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection.db;

try {
  await ensureIndex({
    collection: db.collection("messages"),
    key: { business: 1, inReplyToMessage: 1 },
    name: "message_business_inbound_reply_unique",
    unique: true,
    partialFilterExpression: {
      inReplyToMessage: { $type: "objectId" },
    },
  });

  await ensureIndex({
    collection: db.collection("smsprocessingjobs"),
    key: { inboundMessage: 1 },
    name: "sms_processing_inbound_unique",
    unique: true,
  });

  await ensureIndex({
    collection: db.collection("messages"),
    key: {
      direction: 1,
      provider: 1,
      "metadata.processingRequired": 1,
      "metadata.processingEnqueuedAt": 1,
      createdAt: 1,
    },
    name: "sms_ingress_orphan_reconciliation",
  });

  await ensureIndex({
    collection: db.collection("smsdeliveryreconciliationevents"),
    key: { business: 1, eventKey: 1 },
    name: "sms_delivery_reconciliation_event_unique",
    unique: true,
  });

  await ensureIndex({
    collection: db.collection("smsdeliveryreconciliationevents"),
    key: {
      status: 1,
      availableAt: 1,
      leaseExpiresAt: 1,
      createdAt: 1,
    },
    name: "sms_delivery_reconciliation_work_queue",
  });

  console.log("SMS reliability indexes are ready.");
} finally {
  await mongoose.disconnect();
}
