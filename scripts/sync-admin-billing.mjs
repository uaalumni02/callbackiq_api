import "dotenv/config";
import mongoose from "mongoose";
import Subscription from "../src/models/subscription.js";
import { syncBusinessBillingReport } from "../src/services/admin/billingReporting.service.js";
if (!process.env.MONGO_URL || !process.env.STRIPE_SECRET_KEY)
  throw new Error("MONGO_URL and STRIPE_SECRET_KEY are required");
try {
  await mongoose.connect(process.env.MONGO_URL);
  let synced = 0,
    failed = 0;
  for await (const sub of Subscription.find({
    stripeSubscriptionId: { $gt: "" },
  })
    .select("business")
    .lean()
    .cursor({ batchSize: 25 })) {
    try {
      await syncBusinessBillingReport(sub.business, { force: true });
      synced++;
    } catch (error) {
      failed++;
      console.error(
        "Billing report sync failed",
        String(sub.business),
        error.code || error.name,
      );
    }
  }
  console.log(
    JSON.stringify({ synced, failed, providerOperations: "read-only" }),
  );
  if (failed) process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
