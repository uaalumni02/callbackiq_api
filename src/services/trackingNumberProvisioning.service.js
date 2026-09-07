import { safeConsole } from "../helpers/logging/safeLogger.js";
import twilio from "twilio";

import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import {
  attachPhoneNumberToBusinessMessagingRegistration,
  toMessagingComplianceUpdate,
} from "./a2pMessagingRegistration.service.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";
import { buildTwilioWebhookUrls } from "./twilioWebhookReliability.service.js";

import {
  acquireOperationLease,
  releaseOperationLease,
} from "./operationLease.service.js";
import {
  assertAutomaticProvisioningBudget,
  provisioningBudgetEnabled,
} from "./trialTelecomGuard.service.js";
import { securityGateEnabled } from "./trialIdentityVerification.service.js";
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
  return Business.findById(id).select("+trackingNumber.providerSid +messagingCompliance.messagingServiceSid");
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
  // CALLBACKIQ_TWILIO_RELIABILITY_URLS
  return buildTwilioWebhookUrls(getWebhookBaseUrl());
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

export const isTrackingNumberStateInconsistent = (business) => {
  const state = String(business?.trackingNumber?.status || "unassigned");
  const providerSid = String(business?.trackingNumber?.providerSid || "").trim();
  return Boolean(
    business?.phone &&
      (!["assigned", "verified", "active"].includes(state) || !providerSid),
  );
};

const findProviderNumberByPhone = async (client, phone) => {
  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return null;

  let candidates = [];
  try {
    candidates = await client.incomingPhoneNumbers.list({
      phoneNumber: normalized,
      limit: 20,
    });
  } catch (_filteredLookupError) {
    // Some Twilio helper versions/accounts do not support the phoneNumber
    // filter consistently. Fall back to the account inventory, but only on
    // this rare invariant-recovery path.
    candidates = await client.incomingPhoneNumbers.list({ limit: 1000 });
  }

  return (
    candidates.find(
      (candidate) =>
        normalizePhoneToE164(candidate?.phoneNumber) === normalized,
    ) || null
  );
};

export const reconcileExistingTrackingNumber = async ({
  business,
  client = getClient(),
}) => {
  const normalized = normalizePhoneToE164(business?.phone);
  if (!normalized) {
    throw provisioningError(
      "TRACKING_NUMBER_STATE_INCONSISTENT",
      "A CallBackIQ phone is stored, but it is not a valid E.164 number. Reconcile the business record before provisioning another number.",
      409,
    );
  }

  const incoming = await findProviderNumberByPhone(client, normalized);
  if (!incoming?.sid) {
    throw provisioningError(
      "TRACKING_NUMBER_STATE_INCONSISTENT",
      "A CallBackIQ phone is already stored for this business, but the number could not be verified in the configured Twilio account. No replacement number was purchased.",
      409,
    );
  }

  const expected = webhookUrls();
  const webhookMatches =
    incoming.voiceUrl === expected.voiceUrl &&
    incoming.voiceFallbackUrl === expected.voiceFallbackUrl &&
    incoming.smsUrl === expected.smsUrl &&
    incoming.smsFallbackUrl === expected.smsFallbackUrl &&
    incoming.statusCallback === expected.statusCallback;

  if (!webhookMatches) {
    await client.incomingPhoneNumbers(incoming.sid).update({
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
  }

  const now = new Date();
  const providerCreatedAt = incoming.dateCreated
    ? new Date(incoming.dateCreated)
    : now;

  return Business.findByIdAndUpdate(
    business._id,
    {
      $set: {
        phone: normalized,
        phoneLookup: normalized,
        "trackingNumber.provider": "twilio",
        "trackingNumber.providerSid": String(incoming.sid),
        "trackingNumber.status": "active",
        "trackingNumber.assignedAt":
          business.trackingNumber?.assignedAt || providerCreatedAt,
        "trackingNumber.verifiedAt":
          business.trackingNumber?.verifiedAt || now,
        "trackingNumber.activatedAt":
          business.trackingNumber?.activatedAt || now,
        "trackingNumber.updatedAt": now,
        "trackingNumber.lastError": "",
        "setupProgress.trackingNumberAssigned": true,
        "setupProgress.trackingNumberVerified": true,
        "setupProgress.trackingNumberActive": true,
        "setupProgress.updatedAt": now,
      },
    },
    { returnDocument: "after" },
  ).select("+trackingNumber.providerSid");
};

export const assignTrackingNumber = async (businessOrId) => {
  const initialBusiness = await loadBusiness(businessOrId);
  if (!initialBusiness) {
    throw provisioningError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }

  const subscription = await requireSubscription(initialBusiness._id);

  if (
    subscription?.status === "trialing" &&
    securityGateEnabled("TRIAL_REQUIRE_PHONE_VERIFICATION")
  ) {
    const currentForwardingPhone = normalizePhoneToE164(
      initialBusiness.forwardingPhone,
    );
    const verifiedForwardingPhone = normalizePhoneToE164(
      initialBusiness.forwardingPhoneVerifiedValue,
    );
    if (
      !initialBusiness.forwardingPhoneVerifiedAt ||
      !currentForwardingPhone ||
      verifiedForwardingPhone !== currentForwardingPhone
    ) {
      throw provisioningError(
        "TRIAL_PHONE_VERIFICATION_REQUIRED",
        "Verify ownership of the forwarding phone before a trial tracking number can be purchased.",
        403,
      );
    }
  }

  if (!initialBusiness.forwardingPhone) {
    throw provisioningError(
      "FORWARDING_PHONE_REQUIRED",
      "Add the existing business phone used for routing before assigning a CallBackIQ number.",
    );
  }

  const initialState = initialBusiness.trackingNumber?.status || "unassigned";
  if (
    initialBusiness.phone &&
    ["assigned", "verified", "active"].includes(initialState) &&
    String(initialBusiness.trackingNumber?.providerSid || "").trim()
  ) {
    return initialBusiness;
  }

  let lease = null;
  let globalProvisionLease = null;
  let purchasedProviderSid = "";
  let purchasePersisted = false;

  try {
    lease = await acquireOperationLease({
      key: `tracking-number:${initialBusiness._id}`,
      ttlMs: Number(process.env.TRACKING_NUMBER_PROVISIONING_LEASE_MS || 120_000),
      busyCode: "TRACKING_NUMBER_PROVISIONING_IN_PROGRESS",
      busyMessage:
        "A CallBackIQ number is already being assigned to this business. Retry shortly.",
      busyStatusCode: 409,
      waitMs: Number(process.env.TRACKING_NUMBER_PROVISIONING_WAIT_MS || 3_000),
      retryDelayMs: 100,
    });

    // Re-read after obtaining the cross-process lease. A request that finished
    // while this one was waiting must win without purchasing a second number.
    const business = await loadBusiness(initialBusiness._id);
    if (!business) {
      throw provisioningError("BUSINESS_NOT_FOUND", "Business not found.", 404);
    }

    const currentState = business.trackingNumber?.status || "unassigned";
    if (
      business.phone &&
      ["assigned", "verified", "active"].includes(currentState) &&
      String(business.trackingNumber?.providerSid || "").trim()
    ) {
      return business;
    }

    if (business.phone) {
      // A stored phone means CallBackIQ may already own a carrier resource.
      // Reconcile the provider identity and webhooks before any purchase path.
      // If Twilio cannot verify it, fail closed instead of buying a duplicate.
      return reconcileExistingTrackingNumber({
        business,
        client: getClient(),
      });
    }

    if (provisioningBudgetEnabled()) {
      globalProvisionLease = await acquireOperationLease({
        key: "tracking-number:global-auto-provision",
        ttlMs: Number(
          process.env.TWILIO_GLOBAL_PROVISIONING_LEASE_MS || 120_000,
        ),
        busyCode: "TWILIO_GLOBAL_PROVISIONING_IN_PROGRESS",
        busyMessage:
          "Another tracking-number purchase is being finalized. Retry shortly.",
        busyStatusCode: 409,
        waitMs: Number(
          process.env.TWILIO_GLOBAL_PROVISIONING_WAIT_MS || 5_000,
        ),
        retryDelayMs: 100,
      });
    }

    await assertAutomaticProvisioningBudget();

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
      voiceFallbackMethod: "POST",
      voiceFallbackUrl: urls.voiceFallbackUrl,
      smsMethod: "POST",
      smsUrl: urls.smsUrl,
      smsFallbackMethod: "POST",
      smsFallbackUrl: urls.smsFallbackUrl,
      statusCallbackMethod: "POST",
      statusCallback: urls.statusCallback,
    });

    purchasedProviderSid = String(incoming?.sid || "");
    if (!purchasedProviderSid) {
      throw provisioningError(
        "TRACKING_NUMBER_PROVIDER_RESPONSE_INVALID",
        "Twilio did not return a phone-number identifier.",
        502,
      );
    }

    const a2pState = await attachPhoneNumberToBusinessMessagingRegistration({
      client,
      business,
      phoneNumberSid: purchasedProviderSid,
    });

    // A freshly provisioned CallBackIQ number is managed by the automated A2P
    // lifecycle even when the customer has not submitted its TrustHub details
    // yet. Mark it pending so the shared SMS sender fails closed rather than
    // treating it as a legacy/unmanaged sender.
    const managedA2pState =
      a2pState?.a2pStatus === "unconfigured"
        ? {
            ...a2pState,
            a2pStatus: "pending",
            smsReady: false,
            lastError:
              a2pState.lastError ||
              "A2P_REGISTRATION_REQUIRED: Complete messaging registration before SMS is enabled.",
          }
        : a2pState;

    const normalized = normalizePhoneToE164(
      incoming.phoneNumber || selected,
    );
    const now = new Date();
    const updated = await Business.findByIdAndUpdate(
      business._id,
      {
        $set: {
          ...toMessagingComplianceUpdate(managedA2pState),
          phone: normalized,
          phoneLookup: normalized,
          "trackingNumber.status": "assigned",
          "trackingNumber.provider": "twilio",
          "trackingNumber.providerSid": purchasedProviderSid,
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

    if (!updated) {
      throw provisioningError(
        "TRACKING_NUMBER_PERSISTENCE_FAILED",
        "The purchased tracking number could not be saved.",
        500,
      );
    }

    purchasePersisted = true;
    return updated;
  } catch (error) {
    if (purchasedProviderSid && !purchasePersisted) {
      try {
        const cleanupClient = getClient();
        await cleanupClient.incomingPhoneNumbers(purchasedProviderSid).remove();
      } catch (cleanupError) {
        const status = Number(
          cleanupError?.status || cleanupError?.statusCode || 0,
        );
        if (status !== 404) {
          safeConsole.error("[tracking-number] orphan cleanup failed", {
            businessId: String(initialBusiness._id),
            providerSid: purchasedProviderSid,
            code: cleanupError?.code || status || "unknown",
          });
        }
      }
    }

    await setFailure(initialBusiness._id, error);
    throw error;
  } finally {
    await releaseOperationLease(globalProvisionLease);
    await releaseOperationLease(lease);
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
        voiceFallbackMethod: "POST",
        voiceFallbackUrl: expected.voiceFallbackUrl,
        smsMethod: "POST",
        smsUrl: expected.smsUrl,
        smsFallbackMethod: "POST",
        smsFallbackUrl: expected.smsFallbackUrl,
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
          "messagingCompliance.smsReady": false,
          "messagingCompliance.senderAttached": false,
          "messagingCompliance.senderAttachedAt": null,
          "messagingCompliance.lastCheckedAt": new Date(),
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
