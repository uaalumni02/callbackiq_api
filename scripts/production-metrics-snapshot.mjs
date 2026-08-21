// CALLBACKIQ_PRODUCTION_HARDENING_V1
import mongoose from "mongoose";
import "dotenv/config";
import connectDB from "../src/db/connection.js";
import {
  normalizeRuntimeEnvironment,
} from "../src/config/runtime-environment.js";

normalizeRuntimeEnvironment();
await connectDB();

const snapshot = {
  timestamp: new Date().toISOString(),
  process: {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
  },
  mongo: {
    readyState: mongoose.connection.readyState,
  },
  queues: {},
};

const safeCount = async (modulePath, modelLabel, counts) => {
  try {
    const { default: Model } = await import(modulePath);
    snapshot.queues[modelLabel] = {};
    for (const [label, filter] of Object.entries(counts)) {
      snapshot.queues[modelLabel][label] = await Model.countDocuments(filter);
    }
  } catch (error) {
    snapshot.queues[modelLabel] = {
      unavailable: error?.message || String(error),
    };
  }
};

await safeCount("../src/models/smsProcessingJob.js", "smsProcessing", {
  pending: { status: "pending" },
  processing: { status: "processing" },
  failed: { status: "failed" },
  dead: { status: "dead" },
});

await safeCount("../src/models/a2pCustomerRegistration.js", "a2p", {
  pending: { status: { $in: ["pending", "in_progress", "submitted"] } },
  failed: { status: { $in: ["failed", "rejected"] } },
});

console.log(JSON.stringify(snapshot, null, 2));
await mongoose.connection.close();
