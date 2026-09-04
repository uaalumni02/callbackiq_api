#!/usr/bin/env node
import process from "node:process";
import mongoose from "mongoose";
import twilio from "twilio";
import {
  buildTwilioWebhookUrls,
} from "../src/services/twilioWebhookReliability.service.js";
import {
  assertTwilioProductionConfig,
} from "../src/config/twilio-production-config.js";

const apply = process.argv.includes("--apply");

if (!process.env.MONGO_URL) {
  throw new Error("MONGO_URL is required.");
}
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  throw new Error(
    "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.",
  );
}

const { webhookBaseUrl } = assertTwilioProductionConfig({
  ...process.env,
  NODE_ENV: "production",
});
const expected = buildTwilioWebhookUrls(webhookBaseUrl);
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

const firstText = (...values) =>
  values.map((value) => String(value || "").trim()).find(Boolean) || "";
const candidateProviderSid = (record = {}) =>
  firstText(
    record.providerSid,
    record.providerNumberSid,
    record.phoneSid,
    record.twilioPhoneSid,
    record.numberSid,
  );
const candidatePhone = (record = {}) =>
  firstText(record.phoneNumber, record.phone, record.phoneLookup);

await mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection.db;

try {
  const businesses = db.collection("businesses");
  const trackingNumbers = db.collection("trackingnumbers");
  const targets = [];

  // Current CallBackIQ uses a dedicated TrackingNumber model. Read it first.
  const numberDocs = await trackingNumbers
    .find({ provider: "twilio" })
    .project({
      business: 1,
      businessId: 1,
      providerSid: 1,
      providerNumberSid: 1,
      phoneSid: 1,
      twilioPhoneSid: 1,
      numberSid: 1,
      phoneNumber: 1,
      phone: 1,
      phoneLookup: 1,
      messagingServiceSid: 1,
      status: 1,
    })
    .toArray();

  for (const number of numberDocs) {
    const businessId = number.business || number.businessId || null;
    const business = businessId
      ? await businesses.findOne(
          { _id: businessId },
          {
            projection: {
              businessName: 1,
              "messagingCompliance.messagingServiceSid": 1,
            },
          },
        )
      : null;

    targets.push({
      businessId,
      businessName: business?.businessName || "",
      providerSid: candidateProviderSid(number),
      phoneNumber: candidatePhone(number),
      messagingServiceSid: firstText(
        number.messagingServiceSid,
        business?.messagingCompliance?.messagingServiceSid,
      ),
    });
  }

  // Preserve compatibility with any older records that stored Twilio number
  // metadata directly on Business.
  const legacyBusinesses = await businesses
    .find({
      "trackingNumber.provider": "twilio",
    })
    .project({
      businessName: 1,
      trackingNumber: 1,
      "messagingCompliance.messagingServiceSid": 1,
    })
    .toArray();

  for (const business of legacyBusinesses) {
    targets.push({
      businessId: business._id,
      businessName: business.businessName || "",
      providerSid: candidateProviderSid(business.trackingNumber || {}),
      phoneNumber: candidatePhone(business.trackingNumber || {}),
      messagingServiceSid: firstText(
        business?.messagingCompliance?.messagingServiceSid,
      ),
    });
  }

  const seen = new Set();
  const resolvedTargets = [];
  for (const target of targets) {
    let sid = target.providerSid;
    if (!sid && target.phoneNumber) {
      const matches = await client.incomingPhoneNumbers.list({
        phoneNumber: target.phoneNumber,
        limit: 1,
      });
      sid = firstText(matches?.[0]?.sid);
    }
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    resolvedTargets.push({ ...target, providerSid: sid });
  }

  console.log(
    `Mode: ${apply ? "APPLY" : "DRY RUN"} | numbers=${resolvedTargets.length}`,
  );

  let changed = 0;
  for (const target of resolvedTargets) {
    const incoming = await client
      .incomingPhoneNumbers(target.providerSid)
      .fetch();
    const needsUpdate =
      incoming.voiceUrl !== expected.voiceUrl ||
      incoming.voiceFallbackUrl !== expected.voiceFallbackUrl ||
      incoming.smsUrl !== expected.smsUrl ||
      incoming.smsFallbackUrl !== expected.smsFallbackUrl ||
      incoming.statusCallback !== expected.statusCallback;

    console.log(
      `${needsUpdate ? "CHANGE" : "OK    "} ${target.businessName || target.businessId || "unknown-business"} ${target.providerSid}`,
    );

    if (!apply) continue;

    if (needsUpdate) {
      await client.incomingPhoneNumbers(target.providerSid).update({
        voiceMethod: "POST",
        voiceUrl: expected.voiceUrl,
        voiceFallbackMethod: "POST",
        voiceFallbackUrl: expected.voiceFallbackUrl,
        smsMethod: "POST",
        smsUrl: expected.smsUrl,
        smsFallbackMethod: "POST",
        smsFallbackUrl: expected.smsFallbackUrl,
        statusCallbackMethod: "POST",
        statusCallback: expected.statusCallback,
      });
      changed += 1;
    }

    if (target.messagingServiceSid) {
      const service = client.messaging.v1.services(
        target.messagingServiceSid,
      );
      if (typeof service?.update === "function") {
        await service.update({
          useInboundWebhookOnNumber: true,
        });
      }
    }
  }

  console.log(
    apply
      ? `Applied reliability configuration to ${changed} Twilio number(s).`
      : "Dry run complete. Re-run with --apply to update Twilio.",
  );
} finally {
  await mongoose.disconnect();
}
