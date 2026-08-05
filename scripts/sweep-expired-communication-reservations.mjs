#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";
import { sweepExpiredCommunicationReservations } from "../src/services/communicationUsageReservation.service.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if (!uri) throw new Error("MONGODB_URI, MONGO_URI, or MONGO_URL is required.");
await mongoose.connect(uri);
try {
  const result = await sweepExpiredCommunicationReservations({
    limit: Number(process.env.COMMUNICATION_RESERVATION_SWEEP_BATCH_SIZE) || 500,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await mongoose.disconnect();
}
