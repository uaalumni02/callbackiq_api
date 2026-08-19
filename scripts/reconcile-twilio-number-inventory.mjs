import mongoose from "mongoose";
import twilio from "twilio";

import Business from "../src/models/business.js";
import SecurityAlertService from "../src/services/securityAlert.service.js";

const APPLY = process.argv.includes("--release-orphans");
const MIN_ORPHAN_AGE_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.TWILIO_ORPHAN_MIN_AGE_MS) || 30 * 60 * 1000,
);

const mongoUri =
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "";

if (!mongoUri) throw new Error("MongoDB URI is required.");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) throw new Error("Twilio credentials are required.");

await mongoose.connect(mongoUri);

try {
  const client = twilio(accountSid, authToken);
  const businesses = await Business.find({})
    .select("+trackingNumber.providerSid businessName")
    .lean();

  const ownedSids = new Set(
    businesses
      .map((item) => String(item?.trackingNumber?.providerSid || "").trim())
      .filter(Boolean),
  );

  const providerNumbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  const now = Date.now();
  const orphans = providerNumbers.filter((number) => {
    const name = String(number?.friendlyName || "");
    if (!name.startsWith("CallBackIQ -")) return false;
    if (ownedSids.has(String(number?.sid || ""))) return false;

    const createdAt = number?.dateCreated
      ? new Date(number.dateCreated).getTime()
      : 0;
    return !createdAt || now - createdAt >= MIN_ORPHAN_AGE_MS;
  });

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "release-orphans" : "dry-run",
        databaseTrackingNumbers: ownedSids.size,
        providerNumbers: providerNumbers.length,
        callbackiqOrphans: orphans.map((item) => ({
          sid: item.sid,
          phoneNumber: item.phoneNumber,
          friendlyName: item.friendlyName,
          dateCreated: item.dateCreated || null,
        })),
      },
      null,
      2,
    ),
  );

  if (orphans.length) {
    await SecurityAlertService.dispatch(
      "twilio_orphan_numbers_detected",
      { count: orphans.length, apply: APPLY },
      "error",
    ).catch(() => {});
  }

  if (APPLY) {
    for (const number of orphans) {
      await client.incomingPhoneNumbers(number.sid).remove();
      console.log(`Released orphan ${number.sid} ${number.phoneNumber}`);
    }
  }

  if (orphans.length && !APPLY) {
    process.exitCode = 2;
  }
} finally {
  await mongoose.disconnect();
}
