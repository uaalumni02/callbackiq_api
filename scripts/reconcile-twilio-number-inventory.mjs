import mongoose from "mongoose";
import twilio from "twilio";

import Business from "../src/models/business.js";
import CallLog from "../src/models/callLog.js";
import Message from "../src/models/message.js";
import SecurityAlertService from "../src/services/securityAlert.service.js";
import { normalizePhoneToE164 } from "../src/voice/voicePhone.service.js";

const APPLY = process.argv.includes("--release-orphans");
const RELEASE_CONFIRMATION =
  String(process.env.TWILIO_ORPHAN_RELEASE_CONFIRMATION || "") ===
  "I_UNDERSTAND";
const MIN_ORPHAN_AGE_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.TWILIO_ORPHAN_MIN_AGE_MS) || 30 * 60 * 1000,
);
const RECENT_ACTIVITY_DAYS = Math.max(
  7,
  Number(process.env.TWILIO_ORPHAN_ACTIVITY_LOOKBACK_DAYS) || 30,
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

if (APPLY && !RELEASE_CONFIRMATION) {
  throw new Error(
    'Refusing destructive release. Set TWILIO_ORPHAN_RELEASE_CONFIRMATION="I_UNDERSTAND" after reviewing the dry-run report.',
  );
}

await mongoose.connect(mongoUri);

try {
  const client = twilio(accountSid, authToken);
  const businesses = await Business.find({})
    .select("+trackingNumber.providerSid businessName phone")
    .lean();

  const ownedSids = new Set(
    businesses
      .map((item) => String(item?.trackingNumber?.providerSid || "").trim())
      .filter(Boolean),
  );
  const ownedPhones = new Set(
    businesses
      .map((item) => normalizePhoneToE164(item?.phone))
      .filter(Boolean),
  );

  const providerNumbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  const now = Date.now();
  const activityCutoff = new Date(
    now - RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000,
  );

  const candidates = providerNumbers.filter((number) => {
    const name = String(number?.friendlyName || "");
    const sid = String(number?.sid || "");
    const phone = normalizePhoneToE164(number?.phoneNumber);
    if (!name.startsWith("CallBackIQ -")) return false;
    if (ownedSids.has(sid)) return false;
    if (phone && ownedPhones.has(phone)) return false;

    const createdAt = number?.dateCreated
      ? new Date(number.dateCreated).getTime()
      : 0;
    return !createdAt || now - createdAt >= MIN_ORPHAN_AGE_MS;
  });

  const evaluated = [];
  for (const number of candidates) {
    const phone = normalizePhoneToE164(number?.phoneNumber);
    const recentActivity = phone
      ? Boolean(
          (await CallLog.exists({
            createdAt: { $gte: activityCutoff },
            $or: [{ from: phone }, { to: phone }],
          })) ||
            (await Message.exists({
              createdAt: { $gte: activityCutoff },
              $or: [{ from: phone }, { to: phone }],
            })),
        )
      : true;

    evaluated.push({
      sid: number.sid,
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      dateCreated: number.dateCreated || null,
      recentActivity,
      releasable: !recentActivity,
    });
  }

  const releasable = evaluated.filter((item) => item.releasable);

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "release-orphans" : "dry-run",
        safety: {
          requiresSidAbsent: true,
          requiresPhoneAbsent: true,
          activityLookbackDays: RECENT_ACTIVITY_DAYS,
          destructiveConfirmationRequired: true,
        },
        databaseTrackingSids: ownedSids.size,
        databaseTrackingPhones: ownedPhones.size,
        providerNumbers: providerNumbers.length,
        candidates: evaluated,
        releasable,
      },
      null,
      2,
    ),
  );

  if (evaluated.length) {
    await SecurityAlertService.dispatch(
      "twilio_orphan_numbers_detected",
      {
        candidates: evaluated.length,
        releasable: releasable.length,
        apply: APPLY,
      },
      "error",
    ).catch(() => {});
  }

  if (APPLY) {
    for (const number of releasable) {
      await client.incomingPhoneNumbers(number.sid).remove();
      console.log(`Released orphan ${number.sid} ${number.phoneNumber}`);
    }
  }

  if (releasable.length && !APPLY) {
    process.exitCode = 2;
  }
} finally {
  await mongoose.disconnect();
}
