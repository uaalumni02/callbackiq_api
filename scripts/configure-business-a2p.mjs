import "dotenv/config";
import mongoose from "mongoose";
import twilio from "twilio";

import Business from "../src/models/business.js";
import {
  attachPhoneNumberToBusinessMessagingRegistration,
  toMessagingComplianceUpdate,
} from "../src/services/a2pMessagingRegistration.service.js";
import { normalizePhoneToE164 } from "../src/voice/voicePhone.service.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [arg.replace(/^--/, ""), true];
  }),
);

const mongoUri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) throw new Error("MONGO_URL, MONGODB_URI, or MONGO_URI is required.");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) {
  throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.");
}

const client = twilio(accountSid, authToken);

const findBusiness = async () => {
  if (args["business-id"]) {
    return Business.findById(args["business-id"]).select(
      "+trackingNumber.providerSid +messagingCompliance.messagingServiceSid",
    );
  }
  if (args["business-name"]) {
    return Business.findOne({ businessName: args["business-name"] }).select(
      "+trackingNumber.providerSid +messagingCompliance.messagingServiceSid",
    );
  }
  throw new Error("Pass --business-id=<id> or --business-name=<exact name>.");
};

const discoverMessagingServiceSid = async (registeredNumber) => {
  const normalized = normalizePhoneToE164(registeredNumber);
  if (!normalized) throw new Error("--registered-number must be a valid phone number.");

  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: normalized, limit: 20 });
  const source = numbers.find(
    (number) => normalizePhoneToE164(number.phoneNumber) === normalized,
  );
  if (!source?.sid) {
    throw new Error("Twilio number " + normalized + " was not found in this account.");
  }

  const services = await client.messaging.v1.services.list({ limit: 1000 });
  for (const service of services) {
    const senders = await client.messaging.v1.services(service.sid).phoneNumbers.list({ limit: 1000 });
    if (senders.some((sender) => String(sender.phoneNumberSid || sender.sid) === String(source.sid))) {
      return service.sid;
    }
  }

  throw new Error(
    "No Messaging Service Sender Pool contains " + normalized + ". Confirm the already-registered number is attached to the approved A2P Messaging Service.",
  );
};

await mongoose.connect(mongoUri);
try {
  const business = await findBusiness();
  if (!business) throw new Error("Business not found.");

  const messagingServiceSid = String(
    args["messaging-service-sid"] ||
      (args["registered-number"]
        ? await discoverMessagingServiceSid(args["registered-number"])
        : ""),
  ).trim();

  if (!/^MG[0-9a-fA-F]{32}$/.test(messagingServiceSid)) {
    throw new Error(
      "Pass --messaging-service-sid=MG... or --registered-number=+1... so the approved Messaging Service can be discovered.",
    );
  }

  business.set("messagingCompliance.messagingServiceSid", messagingServiceSid);
  business.set("messagingCompliance.a2pStatus", "configured");
  business.set("messagingCompliance.smsReady", false);
  business.set("messagingCompliance.lastError", "");
  business.set("messagingCompliance.lastCheckedAt", new Date());
  await business.save();

  let result = null;
  let phoneNumberSid = business.trackingNumber?.providerSid || "";

  if (!phoneNumberSid && business.phone) {
    const normalizedCurrentNumber = normalizePhoneToE164(business.phone);
    if (normalizedCurrentNumber) {
      const currentNumbers = await client.incomingPhoneNumbers.list({
        phoneNumber: normalizedCurrentNumber,
        limit: 20,
      });
      const currentNumber = currentNumbers.find(
        (number) =>
          normalizePhoneToE164(number.phoneNumber) === normalizedCurrentNumber,
      );
      phoneNumberSid = currentNumber?.sid || "";
    }
  }

  if (phoneNumberSid) {
    result = await attachPhoneNumberToBusinessMessagingRegistration({
      client,
      business,
      phoneNumberSid,
    });
    await Business.updateOne(
      { _id: business._id },
      { $set: toMessagingComplianceUpdate(result) },
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        businessId: String(business._id),
        businessName: business.businessName,
        messagingServiceSid,
        currentTrackingNumberSid: phoneNumberSid || null,
        currentNumberLink: result,
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
