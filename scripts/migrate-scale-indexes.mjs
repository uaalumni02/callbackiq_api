// CALLBACKIQ_SCALE_HARDENING_V1
import "dotenv/config";
import mongoose from "mongoose";

import connectDB from "../src/db/connection.js";
import { normalizeRuntimeEnvironment } from "../src/config/runtime-environment.js";

import Alert from "../src/models/alert.js";
import Appointment from "../src/models/appointment.js";
import CallLog from "../src/models/callLog.js";
import Conversation from "../src/models/conversation.js";
import ConversionEvent from "../src/models/conversionEvent.js";
import Lead from "../src/models/lead.js";
import SmsProcessingJob from "../src/models/smsProcessingJob.js";

const dryRun = process.argv.includes("--dry-run");

const definitions = [
  [Lead, { business: 1, firstRespondedAt: -1 }, "lead_business_first_responded"],
  [Lead, { business: 1, qualifiedAt: -1 }, "lead_business_qualified"],
  [Lead, { business: 1, recovered: 1, bookedAt: -1 }, "lead_business_recovered_booked"],
  [Lead, { business: 1, latestMarketingSource: 1, createdAt: -1 }, "lead_business_marketing_created"],
  [Conversation, { business: 1, status: 1, "bookingState.status": 1, lastMessageAt: -1 }, "conversation_business_pipeline"],
  [Appointment, { business: 1, status: 1, confirmedAt: -1 }, "appointment_business_status_confirmed"],
  [Appointment, { business: 1, marketingSource: 1, confirmedAt: -1 }, "appointment_business_marketing_confirmed"],
  [CallLog, { business: 1, status: 1, createdAt: -1 }, "calllog_business_status_created"],
  [CallLog, { business: 1, marketingSource: 1, createdAt: -1 }, "calllog_business_marketing_created"],
  [ConversionEvent, { business: 1, type: 1, occurredAt: -1 }, "conversion_business_type_occurred"],
  [ConversionEvent, { business: 1, marketingSource: 1, type: 1, occurredAt: -1 }, "conversion_business_marketing_type_occurred"],
  [Alert, { business: 1, resolvedAt: 1, type: 1, priority: -1, dueAt: 1, createdAt: -1 }, "alert_business_owner_attention"],
  [SmsProcessingJob, { status: 1, availableAt: 1, priority: -1, createdAt: 1 }, "sms_job_claim_queue"],
];

const sameKey = (left, right) =>
  JSON.stringify(Object.entries(left || {})) ===
  JSON.stringify(Object.entries(right || {}));

const inspectOrApply = async ([model, key, name]) => {
  let existing = [];
  try {
    existing = await model.collection.indexes();
  } catch (error) {
    if (Number(error?.code) !== 26) throw error;
  }

  const match = existing.find(
    (index) => index.name === name || sameKey(index.key, key),
  );

  if (match) {
    console.log(`INDEX OK ${model.collection.collectionName}:${match.name}`);
    return;
  }

  if (dryRun) {
    console.log(
      `INDEX MISSING ${model.collection.collectionName}:${name}`,
      JSON.stringify(key),
    );
    process.exitCode = 2;
    return;
  }

  const createdName = await model.collection.createIndex(key, {
    name,
    background: true,
  });
  console.log(
    `INDEX CREATED ${model.collection.collectionName}:${createdName}`,
  );
};

normalizeRuntimeEnvironment();
await connectDB();

try {
  for (const definition of definitions) {
    await inspectOrApply(definition);
  }
} finally {
  await mongoose.connection.close();
}
