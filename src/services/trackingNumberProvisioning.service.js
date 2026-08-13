import twilio from "twilio";

import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

export const TRACKING_NUMBER_STATES = [
  "unassigned",
  "assigned",
  "verified",
  "active",
];

const provisioningError = (code, message, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const getClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw provisioningError(
      "TWILIO_PROVISIONING_NOT_CONFIGURED",
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required to provision a CallBackIQ number.",
      503,
    );
  }
  return twilio(accountSid, authToken);
};

const getWebhookBaseUrl = () => {
  const base = String(
    process.env.TWILIO_WEBHOOK_BASE_URL ||
      process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.PUBLIC_API_URL ||
      "",
  ).replace(/\/$/, "");

  if (!/^https:\/\//i.test(base)) {
    throw provisioningError(
      "TWILIO_WEBHOOK_BASE_URL_REQUIRED",
      "A public HTTPS TWILIO_WEBHOOK_BASE_URL is required before a CallBackIQ number can be provisioned.",
      503,
    );
  }
  return base;
};

const requireSubscription = async (businessId) => {
  const subscription = await Subscription.findOne({
    business: businessId,
  }).lean();

  if (
    !subscription?.isActive ||
    !["active", "trialing"].includes(subscription.status) ||
    !String(subscription?.stripeSubscriptionId || "").trim()
  ) {
    throw provisioningError(
      "SUBSCRIPTION_REQUIRED",
      "Register and complete CallBackIQ subscription checkout before a tracking number can be assigned.",
      402,
    );
  }
  return subscription;
};

const loadBusiness = async (businessOrId) => {
  const id = businessOrId?._id || businessOrId;
  return Business.findById(id).select("+trackingNumber.providerSid");
};

const areaCodeFromForwardingPhone = (phone) => {
  const normalized = normalizePhoneToE164(phone);
  const digits = normalized?.replace(/\D/g, "") || "";
  if (digits.length === 11 && digits.startsWith("1")) {
    return Number(digits.slice(1, 4));
  }
  return undefined;
};

const webhookUrls = () => {
  const base = getWebhookBaseUrl();
  return {
    voiceUrl: `${base}/api/twilio/voice`,
    smsUrl: `${base}/api/twilio/sms`,
    statusCallback: `${base}/api/twilio/status`,
  };
};

const setFailure = async (businessId, error) => {
  await Business.updateOne(
    { _id: businessId },
    {
      $set: {
        "trackingNumber.lastError": `${error?.code || "error"}: ${
          error?.message || "Tracking number operation failed"
        }`.slice(0, 1000),
        "trackingNumber.updatedAt": new Date(),
      },
    },
  ).catch(() => {});
};

export const assignTrackingNumber = async (businessOrId) => {
  const business = await loadBusiness(businessOrId);
  if (!business) {
    throw provisioningError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }

  await requireSubscription(business._id);

  if (!business.forwardingPhone) {
    throw provisioningError(
      "FORWARDING_PHONE_REQUIRED",
      "Add the existing business phone used for routing before assigning a CallBackIQ number.",
    );
  }

  const currentState = business.trackingNumber?.status || "unassigned";
  if (
    business.phone &&
    ["assigned", "verified", "active"].includes(currentState)
  ) {
    return business;
  }

  try {
    const client = getClient();
    const areaCode = areaCodeFromForwardingPhone(business.forwardingPhone);
    const candidates = await client
      .availablePhoneNumbers("US")
      .local.list({
        ...(areaCode ? { areaCode } : {}),
        smsEnabled: true,
        voiceEnabled: true,
        limit: 1,
      });

    const selected = candidates?.[0]?.phoneNumber;
    if (!selected) {
      throw provisioningError(
        "NO_TRACKING_NUMBER_AVAILABLE",
        areaCode
          ? `No SMS/voice-capable Twilio number is currently available in area code ${areaCode}.`
          : "No SMS/voice-capable Twilio number is currently available.",
        503,
      );
    }

    const urls = webhookUrls();
    const incoming = await client.incomingPhoneNumbers.create({
      phoneNumber: selected,
      friendlyName: `CallBackIQ - ${String(
        business.businessName || business._id,
      ).slice(0, 45)}`,
      voiceMethod: "POST",
      voiceUrl: urls.voiceUrl,
      smsMethod: "POST",
      smsUrl: urls.smsUrl,
      statusCallbackMethod: "POST",
      statusCallback: urls.statusCallback,
    });

    const normalized = normalizePhoneToE164(
      incoming.phoneNumber || selected,
    );
    const now = new Date();

    return Business.findByIdAndUpdate(
      business._id,
      {
        $set: {
          phone: normalized,
          phoneLookup: normalized,
          "trackingNumber.status": "assigned",
          "trackingNumber.provider": "twilio",
          "trackingNumber.providerSid": incoming.sid,
          "trackingNumber.assignedAt": now,
          "trackingNumber.verifiedAt": null,
          "trackingNumber.activatedAt": null,
          "trackingNumber.lastError": "",
          "trackingNumber.updatedAt": now,
          "setupProgress.trackingNumberAssigned": true,
          "setupProgress.updatedAt": now,
        },
      },
      { returnDocument: "after" },
    ).select("+trackingNumber.providerSid");
  } catch (error) {
    await setFailure(business._id, error);
    throw error;
  }
};

export const verifyTrackingNumber = async (businessOrId) => {
  const business = await loadBusiness(businessOrId);
  if (!business) {
    throw provisioningError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }

  await requireSubscription(business._id);

  if (!business.phone || !business.trackingNumber?.providerSid) {
    throw provisioningError(
      "TRACKING_NUMBER_NOT_ASSIGNED",
      "Assign a CallBackIQ number before verifying it.",
    );
  }

  try {
    const client = getClient();
    const expected = webhookUrls();
    const incoming = await client
      .incomingPhoneNumbers(business.trackingNumber.providerSid)
      .fetch();

    const phoneMatches =
      normalizePhoneToE164(incoming.phoneNumber) ===
      normalizePhoneToE164(business.phone);
    const webhookMatches =
      incoming.voiceUrl === expected.voiceUrl &&
      incoming.smsUrl === expected.smsUrl &&
      incoming.statusCallback === expected.statusCallback;

    if (!phoneMatches) {
      throw provisioningError(
        "TRACKING_NUMBER_PROVIDER_MISMATCH",
        "The assigned Twilio number no longer matches the CallBackIQ business record.",
      );
    }

    if (!webhookMatches) {
      await client
        .incomingPhoneNumbers(business.trackingNumber.providerSid)
        .update({
          voiceMethod: "POST",
          voiceUrl: expected.voiceUrl,
          smsMethod: "POST",
          smsUrl: expected.smsUrl,
          statusCallbackMethod: "POST",
          statusCallback: expected.statusCallback,
        });
    }

    const now = new Date();
    return Business.findByIdAndUpdate(
      business._id,
      {
        $set: {
          "trackingNumber.status": "verified",
          "trackingNumber.verifiedAt": now,
          "trackingNumber.lastError": "",
          "trackingNumber.updatedAt": now,
          "setupProgress.trackingNumberAssigned": true,
          "setupProgress.trackingNumberVerified": true,
          "setupProgress.updatedAt": now,
        },
      },
      { returnDocument: "after" },
    ).select("+trackingNumber.providerSid");
  } catch (error) {
    await setFailure(business._id, error);
    throw error;
  }
};

export const activateTrackingNumber = async (businessOrId) => {
  let business = await loadBusiness(businessOrId);
  if (!business) {
    throw provisioningError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }

  await requireSubscription(business._id);

  if (
    business.trackingNumber?.status !== "verified" &&
    business.trackingNumber?.status !== "active"
  ) {
    business = await verifyTrackingNumber(business);
  }

  if (business.trackingNumber?.status === "active") return business;

  const now = new Date();
  return Business.findByIdAndUpdate(
    business._id,
    {
      $set: {
        "trackingNumber.status": "active",
        "trackingNumber.activatedAt": now,
        "trackingNumber.lastError": "",
        "trackingNumber.updatedAt": now,
        "setupProgress.trackingNumberAssigned": true,
        "setupProgress.trackingNumberVerified": true,
        "setupProgress.trackingNumberActive": true,
        "setupProgress.updatedAt": now,
      },
    },
    { returnDocument: "after" },
  ).select("+trackingNumber.providerSid");
};

export const releaseTrackingNumber = async (businessOrId) => {
  const business = await loadBusiness(businessOrId);
  if (!business) {
    throw provisioningError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }

  const providerSid = business.trackingNumber?.providerSid;

  try {
    if (providerSid) {
      const client = getClient();
      try {
        await client.incomingPhoneNumbers(providerSid).remove();
      } catch (error) {
        // If Twilio already considers the number gone, converge local state
        // instead of retrying forever. Other provider failures remain retryable.
        const status = Number(error?.status || error?.statusCode || 0);
        if (status !== 404) throw error;
      }
    }

    const now = new Date();
    return Business.findByIdAndUpdate(
      business._id,
      {
        $unset: {
          phone: 1,
          phoneLookup: 1,
        },
        $set: {
          "trackingNumber.status": "unassigned",
          "trackingNumber.provider": "twilio",
          "trackingNumber.providerSid": "",
          "trackingNumber.assignedAt": null,
          "trackingNumber.verifiedAt": null,
          "trackingNumber.activatedAt": null,
          "trackingNumber.lastError": "",
          "trackingNumber.updatedAt": now,
          "setupProgress.trackingNumberAssigned": false,
          "setupProgress.trackingNumberVerified": false,
          "setupProgress.trackingNumberActive": false,
          "setupProgress.updatedAt": now,
        },
      },
      { returnDocument: "after" },
    ).select("+trackingNumber.providerSid");
  } catch (error) {
    await setFailure(business._id, error);
    throw error;
  }
};

export const provisionTrackingNumber = async (businessOrId) => {
  let business = await assignTrackingNumber(businessOrId);
  business = await verifyTrackingNumber(business);
  return activateTrackingNumber(business);
};

export default {
  assignTrackingNumber,
  verifyTrackingNumber,
  activateTrackingNumber,
  releaseTrackingNumber,
  provisionTrackingNumber,
};
