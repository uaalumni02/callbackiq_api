#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";
import { sweepExpiredVoiceUsageReservations } from "../src/services/voiceUsage.service.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if (!uri) throw new Error("MONGODB_URI, MONGO_URI, or MONGO_URL is required.");
await mongoose.connect(uri);
try {
  const result = await sweepExpiredVoiceUsageReservations({
    limit: Number(process.env.VOICE_USAGE_SWEEP_BATCH_SIZE) || 500,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await mongoose.disconnect();
}
