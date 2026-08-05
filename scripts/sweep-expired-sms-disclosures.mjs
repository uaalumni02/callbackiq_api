#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";
import { sweepExpiredSmsContactDisclosures } from "../src/services/smsContactDisclosure.service.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if (!uri) {
  console.error("MONGODB_URI, MONGO_URI, or MONGO_URL is required.");
  process.exit(1);
}
await mongoose.connect(uri);
try {
  const result = await sweepExpiredSmsContactDisclosures();
  console.log(JSON.stringify({ deleted: result.deletedCount || 0 }, null, 2));
} finally {
  await mongoose.disconnect();
}
