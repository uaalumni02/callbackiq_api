import "dotenv/config";
import mongoose from "mongoose";
import { reconcileStripeSubscriptionIntegrity } from "../src/services/subscriptionIntegrity.service.js";

const mongoUri =
  process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;

if (!mongoUri) {
  throw new Error("Set MONGO_URL, MONGODB_URI, or MONGO_URI before running reconciliation.");
}

await mongoose.connect(mongoUri);
try {
  const summary = await reconcileStripeSubscriptionIntegrity();
  console.log(JSON.stringify(summary, null, 2));
  if (summary.anomalies > 0 || summary.errors > 0) {
    process.exitCode = 2;
  }
} finally {
  await mongoose.disconnect();
}
