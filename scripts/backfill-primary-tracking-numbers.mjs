// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import "dotenv/config";
import connectDB from "../src/db/connection.js";
import Business from "../src/models/business.js";
import TrackingNumber from "../src/models/trackingNumber.js";
import { normalizePhoneToE164 } from "../src/voice/voicePhone.service.js";

await connectDB();

let scanned = 0;
let mirrored = 0;
let skipped = 0;

for await (const business of Business.find({
  phone: { $exists: true, $nin: [null, ""] },
}).select("+trackingNumber.providerSid")) {
  scanned += 1;
  const phoneNumber = normalizePhoneToE164(business.phone);
  if (!phoneNumber) {
    skipped += 1;
    continue;
  }

  await TrackingNumber.findOneAndUpdate(
    { phoneLookup: phoneNumber },
    {
      $setOnInsert: {
        business: business._id,
        marketingSource: null,
        kind: "primary",
        isPrimary: true,
        phoneNumber,
        phoneLookup: phoneNumber,
        provider: "twilio",
        providerSid: String(business.trackingNumber?.providerSid || ""),
        status:
          business.trackingNumber?.status === "active" ? "active" : "pending",
        voiceEnabled: true,
        smsEnabled: true,
        senderAttached:
          business.messagingCompliance?.senderAttached === true,
        smsReady: business.messagingCompliance?.smsReady === true,
        assignedAt:
          business.trackingNumber?.assignedAt || business.createdAt || new Date(),
        activatedAt: business.trackingNumber?.activatedAt || null,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  mirrored += 1;
}

console.log(
  JSON.stringify(
    {
      scanned,
      mirrored,
      skipped,
      note:
        "Business.phone remains authoritative during the compatibility migration. This script only creates TrackingNumber mirrors.",
    },
    null,
    2,
  ),
);
process.exit(0);
