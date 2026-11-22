import "dotenv/config";
import mongoose from "mongoose";
import { getMongoUrl } from "../src/config/runtime-environment.js";
import { migrateForwardingPhones } from "../src/services/forwardingPhoneMigration.service.js";

const [mode = "--check", ...extra] = process.argv.slice(2);
if (!["--check", "--apply"].includes(mode) || extra.length) {
  throw new Error("Usage: node scripts/migrate-forwarding-phone-uniqueness.mjs --check | --apply");
}
const uri = getMongoUrl();
if (!uri) throw new Error("MONGODB_URI (or MONGO_URL/MONGO_URI) is required.");
await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
try {
  const result = await migrateForwardingPhones(mongoose.connection.db.collection("businesses"), { apply: mode === "--apply" });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) {
    process.exitCode = 2;
    console.error(result.blocked
      ? "Migration blocked. Resolve the listed business records or index conflict before applying. No records or indexes were changed."
      : "Migration required. Pause signup, business edits, and business activation before running --apply.");
  }
} finally {
  await mongoose.disconnect();
}
