import "dotenv/config";
import mongoose from "mongoose";
import { syncProviderBalances } from "../src/services/admin/providerBalances.service.js";
if (!process.env.MONGO_URL) throw new Error("MONGO_URL is required");
try {
  console.log("Connecting to reporting database...");
  await mongoose.connect(process.env.MONGO_URL, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });
  const result = await syncProviderBalances({
    progress: (message) => console.log(message),
  });
  if (
    result.some((r) => r.error && r.error !== "BALANCE_ACCESS_NOT_CONFIGURED")
  )
    process.exitCode = 1;
  console.log(
    "Balance refresh finished. Refresh Admin → Expenses after the summary cache updates (up to 60 seconds).",
  );
} finally {
  await mongoose.disconnect();
}
