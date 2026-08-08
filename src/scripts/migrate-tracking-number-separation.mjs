import "dotenv/config";
import mongoose from "mongoose";

import Business from "../models/business.js";

const uri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  "";

if (!uri) {
  console.error("Set MONGODB_URI or MONGO_URI before running this migration.");
  process.exit(1);
}

const assumeTracking =
  String(process.env.CALLBACKIQ_MIGRATION_ASSUME_EXISTING_PHONE_IS_TRACKING || "")
    .toLowerCase() === "true";

await mongoose.connect(uri);

let movedToForwarding = 0;
let markedTrackingActive = 0;
let untouched = 0;

const businesses = await Business.find({ phone: { $nin: [null, ""] } }).select(
  "+trackingNumber.providerSid",
);

for (const business of businesses) {
  // Defaults are normally materialized by Mongoose, but initialize explicitly
  // so older documents created before these subdocuments existed migrate safely.
  if (!business.trackingNumber) business.trackingNumber = {};
  if (!business.setupProgress) business.setupProgress = {};

  const hasLifecycle =
    business.trackingNumber?.status &&
    business.trackingNumber.status !== "unassigned";

  if (hasLifecycle) {
    untouched += 1;
    continue;
  }

  const now = new Date();

  const currentPhone = String(business.phone || "").replace(/\D/g, "");
  const forwardingPhone = String(business.forwardingPhone || "").replace(/\D/g, "");
  const clearlySeparateTrackingNumber = Boolean(
    currentPhone && forwardingPhone && currentPhone !== forwardingPhone,
  );

  if (assumeTracking || clearlySeparateTrackingNumber) {
    business.trackingNumber = {
      ...(business.trackingNumber?.toObject?.() || business.trackingNumber || {}),
      provider: "twilio",
      status: "active",
      assignedAt: business.trackingNumber?.assignedAt || now,
      verifiedAt: business.trackingNumber?.verifiedAt || now,
      activatedAt: business.trackingNumber?.activatedAt || now,
      updatedAt: now,
      lastError: "",
    };
    business.setupProgress.trackingNumberAssigned = true;
    business.setupProgress.trackingNumberVerified = true;
    business.setupProgress.trackingNumberActive = true;
    business.setupProgress.updatedAt = now;
    await business.save();
    markedTrackingActive += 1;
    continue;
  }

  /*
   * Safe default for registration-era records: the old signup flow put the
   * owner's entered business phone into Business.phone. If no independent
   * forwardingPhone exists, preserve that number as forwardingPhone and clear
   * the tracking number. Set CALLBACKIQ_MIGRATION_ASSUME_EXISTING_PHONE_IS_TRACKING=true
   * only when you know historical Business.phone values are real Twilio numbers.
   */
  if (!business.forwardingPhone) business.forwardingPhone = business.phone;
  business.phone = undefined;
  business.phoneLookup = undefined;
  business.trackingNumber.status = "unassigned";
  business.trackingNumber.provider = "twilio";
  business.trackingNumber.providerSid = "";
  business.trackingNumber.assignedAt = null;
  business.trackingNumber.verifiedAt = null;
  business.trackingNumber.activatedAt = null;
  business.trackingNumber.updatedAt = now;
  business.setupProgress.forwardingPhoneConfigured = true;
  business.setupProgress.trackingNumberAssigned = false;
  business.setupProgress.trackingNumberVerified = false;
  business.setupProgress.trackingNumberActive = false;
  business.setupProgress.updatedAt = now;
  await business.save();
  movedToForwarding += 1;
}


// The previous schema created a non-sparse unique phone index. Recreate it so
// unassigned businesses can omit Business.phone until a tracking number exists.
const indexes = await Business.collection.indexes();
const phoneIndex = indexes.find(
  (index) => index.key?.phone === 1 && Object.keys(index.key || {}).length === 1,
);
if (phoneIndex) {
  await Business.collection.dropIndex(phoneIndex.name);
}
await Business.collection.createIndex(
  { phone: 1 },
  { unique: true, sparse: true, name: "phone_1" },
);

console.log(
  JSON.stringify(
    { movedToForwarding, markedTrackingActive, untouched, assumeTracking },
    null,
    2,
  ),
);

await mongoose.disconnect();
