#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";

import Business from "../src/models/business.js";
import ManualSmsOperation from "../src/models/manualSmsOperation.js";
import { executeManualSmsOperation } from "../src/services/messaging/manualSmsOperation.service.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if (!uri) {
  console.error("MONGODB_URI, MONGO_URI, or MONGO_URL is required.");
  process.exit(1);
}

const limit = Math.max(1, Math.min(1000, Number(process.env.MANUAL_SMS_RECONCILIATION_BATCH_SIZE) || 100));
const minimumAgeMs = Math.max(30_000, Number(process.env.MANUAL_SMS_RECONCILIATION_MIN_AGE_MS) || 60_000);
const cutoff = new Date(Date.now() - minimumAgeMs);

await mongoose.connect(uri);
try {
  const operations = await ManualSmsOperation.find({
    state: { $in: ["dispatching", "provider_accepted", "reconciliation_required"] },
    updatedAt: { $lte: cutoff },
  })
    .sort({ updatedAt: 1 })
    .limit(limit);

  const summary = { inspected: operations.length, completed: 0, pending: 0, failed: 0 };
  for (const operation of operations) {
    try {
      const business = await Business.findById(operation.business);
      if (!business) throw new Error("Business no longer exists.");
      const result = await executeManualSmsOperation({
        business,
        actorId: operation.actor,
        to: operation.to,
        body: operation.body,
        conversationId: operation.conversation,
        operationId: operation.operationId,
        source: operation.metadata?.source || "manual_sms_reconciliation",
      });
      if (result?.completed) summary.completed += 1;
      else summary.pending += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(JSON.stringify({
        event: "manual_sms_reconciliation_failed",
        operationId: String(operation._id),
        code: error?.code || error?.name || "error",
        message: String(error?.message || error).slice(0, 500),
      }));
    }
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await mongoose.disconnect();
}
