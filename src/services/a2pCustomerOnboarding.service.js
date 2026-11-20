import { clean, upper, normalizePhone, normalizeEin, isHttpUrl, formatEvaluationFailure, createMessageSamples, validateCommon, validateAddress, BUSINESS_TYPES } from './a2pRegistrationInput.policy.js';
import { saveStateDocument } from './stateTransitions/documents.js';
import {
  parseEventDate,
  resolveNumberLifecycleStatus,
  numberLifecycleRank,
  shouldIgnoreNumberLifecycleEvent,
} from "./a2pNumberLifecycle.policy.js";
export {
  resolveNumberLifecycleStatus,
  numberLifecycleRank,
  shouldIgnoreNumberLifecycleEvent,
};
import { createTwilioClient } from '../integrations/providerClients.js';

import A2pCustomerRegistration from "../models/a2pCustomerRegistration.js";
import Business from "../models/business.js";
import {
  acquireOperationLease,
  releaseOperationLease,
} from "./operationLease.service.js";
import {
  attachPhoneNumberToBusinessMessagingRegistration,
  toMessagingComplianceUpdate,
} from "./a2pMessagingRegistration.service.js";

export const STANDARD_CUSTOMER_PROFILE_POLICY_SID =
  "RNdfbf3fae0e1107f8aded0e7cead80bf5";
export const STANDARD_A2P_TRUST_POLICY_SID =
  "RNb0d4771c2c98518d916a3d4cd70a8f8b";
export const SOLE_PROP_CUSTOMER_PROFILE_POLICY_SID =
  "RN806dd6cd175f314e1f96a9727ee271f4";
export const SOLE_PROP_A2P_TRUST_POLICY_SID =
  "RN670d5d2e282a6130ae063b234b6019c8";

const env = (name) => clean(process.env[name]);
const requiredEnv = (name) => {
  const value = env(name);
  if (!value) throw new Error(`${name} is required for automated A2P onboarding.`);
  return value;
};

export const getTwilioClient = () =>
  createTwilioClient(requiredEnv("TWILIO_ACCOUNT_SID"), requiredEnv("TWILIO_AUTH_TOKEN"));

const getNotificationEmail = () => requiredEnv("A2P_NOTIFICATION_EMAIL");
const getPrimaryCustomerProfileSid = () => requiredEnv("TWILIO_PRIMARY_CUSTOMER_PROFILE_SID");

const getPublicWebhookBaseUrl = () =>
  clean(
    process.env.TWILIO_WEBHOOK_BASE_URL ||
      process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.API_PUBLIC_URL,
  ).replace(/\/+$/, "");

const selectSecrets =
  "+customerProfileSid +businessEndUserSid +authorizedRepresentativeSid +addressSid +addressDocumentSid +trustProductSid +messagingProfileEndUserSid +brandSid +messagingServiceSid +campaignSid";

export const getRegistrationWithSecrets = (businessId) =>
  A2pCustomerRegistration.findOne({ business: businessId }).select(selectSecrets);

export const toPublicA2pRegistration = (registration) => {
  if (!registration) {
    return {
      status: "not_started",
      registrationType: "low_volume_standard",
      smsReady: false,
      canActivateTrial: false,
      otpRequired: false,
    };
  }
  const row = registration.toObject ? registration.toObject() : registration;
  const publicLastError = row.lastError
    ? "Messaging registration needs attention. Review your details and try again, or contact support."
    : "";
  return {
    status: row.status,
    registrationType: row.registrationType,
    legalBusinessName: row.legalBusinessName,
    businessType: row.businessType,
    businessIndustry: row.businessIndustry,
    websiteUrl: row.websiteUrl,
    customerProfileStatus: row.customerProfileStatus,
    trustProductStatus: row.trustProductStatus,
    brandStatus: row.brandStatus,
    brandIdentityStatus: row.brandIdentityStatus,
    campaignStatus: row.campaignStatus,
    numberStatus: row.numberStatus,
    otpStatus: row.otpStatus,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    lastSyncedAt: row.lastSyncedAt,
    lastError: publicLastError,
    smsReady: row.status === "ready" && upper(row.numberStatus) === "REGISTERED",
    canActivateTrial: !["not_started", "action_required", "failed"].includes(row.status),
    otpRequired: row.status === "otp_required",
  };
};

const ensureMessagingService = async ({ client, registration, businessName }) => {
  if (registration.messagingServiceSid) return registration.messagingServiceSid;
  const webhookBase = getPublicWebhookBaseUrl();
  const service = await client.messaging.v1.services.create({
    friendlyName: `${businessName} - MeekCall A2P`,
    ...(webhookBase ? { inboundRequestUrl: `${webhookBase}/api/twilio/sms` } : {}),
  });
  registration.messagingServiceSid = service.sid;
  await saveStateDocument(registration);
  await Business.updateOne(
    { _id: registration.business },
    {
      $set: {
        "messagingCompliance.messagingServiceSid": service.sid,
        "messagingCompliance.a2pStatus": "pending",
        "messagingCompliance.smsReady": false,
        "messagingCompliance.lastError": "",
        "messagingCompliance.lastCheckedAt": new Date(),
      },
    },
  );
  return service.sid;
};

const ensureAddressResources = async ({ client, registration, legalBusinessName, address }) => {
  if (!registration.addressSid) {
    const twilioAddress = await client.addresses.create({
      customerName: legalBusinessName,
      friendlyName: `${legalBusinessName} A2P address`,
      street: address.street,
      ...(address.streetSecondary ? { streetSecondary: address.streetSecondary } : {}),
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      isoCountry: address.isoCountry,
    });
    registration.addressSid = twilioAddress.sid;
    await saveStateDocument(registration);
  }
  if (!registration.addressDocumentSid) {
    const document = await client.trusthub.v1.supportingDocuments.create({
      attributes: { address_sids: registration.addressSid },
      friendlyName: `${legalBusinessName} A2P address document`,
      type: "customer_profile_address",
    });
    registration.addressDocumentSid = document.sid;
    await saveStateDocument(registration);
  }
};

const assignCustomerProfileObject = async (client, profileSid, objectSid) =>
  client.trusthub.v1
    .customerProfiles(profileSid)
    .customerProfilesEntityAssignments.create({ objectSid });
const assignTrustProductObject = async (client, trustProductSid, objectSid) =>
  client.trusthub.v1
    .trustProducts(trustProductSid)
    .trustProductsEntityAssignments.create({ objectSid });

const evaluateCustomerProfile = async (client, profileSid, policySid) => {
  const evaluation = await client.trusthub.v1
    .customerProfiles(profileSid)
    .customerProfilesEvaluations.create({ policySid });
  if (clean(evaluation.status).toLowerCase() !== "compliant") {
    const error = new Error(formatEvaluationFailure(evaluation));
    error.code = "A2P_CUSTOMER_PROFILE_NONCOMPLIANT";
    throw error;
  }
};

const evaluateTrustProduct = async (client, trustProductSid, policySid) => {
  const evaluation = await client.trusthub.v1
    .trustProducts(trustProductSid)
    .trustProductsEvaluations.create({ policySid });
  if (clean(evaluation.status).toLowerCase() !== "compliant") {
    const error = new Error(formatEvaluationFailure(evaluation));
    error.code = "A2P_TRUST_PRODUCT_NONCOMPLIANT";
    throw error;
  }
};

const createStandardRegistration = async ({ client, registration, input, common }) => {
  const primaryCustomerProfileSid = getPrimaryCustomerProfileSid();
  const notificationEmail = getNotificationEmail();
  const address = validateAddress(input.address);
  if (address.isoCountry !== "US") {
    throw new Error(
      "This automated Standard/Low-Volume Standard flow currently supports U.S. EIN-based businesses only.",
    );
  }
  const ein = normalizeEin(input.ein);
  if (ein.length !== 9) throw new Error("A valid 9-digit EIN is required for Standard/Low-Volume Standard A2P registration.");
  const businessType = clean(input.businessType);
  if (!BUSINESS_TYPES.has(businessType)) throw new Error("Select a valid legal business type.");
  const websiteUrl = clean(input.websiteUrl);
  if (!isHttpUrl(websiteUrl)) throw new Error("A valid business website URL is required.");
  const rep = {
    firstName: clean(input.contact?.firstName),
    lastName: clean(input.contact?.lastName),
    email: common.contactEmail,
    phone: common.contactPhone,
    businessTitle: clean(input.contact?.businessTitle || "Owner"),
    jobPosition: clean(input.contact?.jobPosition || "Owner"),
  };
  if (!rep.firstName || !rep.lastName) throw new Error("Authorized representative first and last name are required.");

  registration.registrationType = common.registrationType;
  registration.legalBusinessName = common.legalBusinessName;
  registration.businessType = businessType;
  registration.businessIndustry = upper(input.businessIndustry || "CONSTRUCTION");
  registration.websiteUrl = websiteUrl;
  registration.contactEmail = common.contactEmail;
  registration.registrationNumberLast4 = ein.slice(-4);
  registration.campaign = {
    description: clean(input.campaign?.description) ||
      `${common.legalBusinessName} uses MeekCall for missed-call recovery and customer-care messaging.`,
    messageFlow: common.campaign.messageFlow,
    messageSamples: createMessageSamples(common.legalBusinessName),
    useCase: "CUSTOMER_CARE",
    hasEmbeddedLinks: common.campaign.hasEmbeddedLinks,
    hasEmbeddedPhone: common.campaign.hasEmbeddedPhone,
    privacyPolicyUrl: common.campaign.privacyPolicyUrl,
    termsAndConditionsUrl: common.campaign.termsAndConditionsUrl,
  };
  await saveStateDocument(registration);

  if (!registration.customerProfileSid) {
    const profile = await client.trusthub.v1.customerProfiles.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} Secondary Customer Profile`,
      policySid: STANDARD_CUSTOMER_PROFILE_POLICY_SID,
    });
    registration.customerProfileSid = profile.sid;
    registration.customerProfileStatus = profile.status || "draft";
    await saveStateDocument(registration);
  }

  if (!registration.businessEndUserSid) {
    const endUser = await client.trusthub.v1.endUsers.create({
      attributes: {
        business_name: common.legalBusinessName,
        website_url: websiteUrl,
        business_regions_of_operation: "USA_AND_CANADA",
        business_type: businessType,
        business_registration_identifier: "EIN",
        business_identity: "direct_customer",
        business_industry: registration.businessIndustry,
        business_registration_number: ein,
      },
      friendlyName: `${common.legalBusinessName} business information`,
      type: "customer_profile_business_information",
    });
    registration.businessEndUserSid = endUser.sid;
    await saveStateDocument(registration);
    await assignCustomerProfileObject(client, registration.customerProfileSid, endUser.sid);
  }

  if (!registration.authorizedRepresentativeSid) {
    const representative = await client.trusthub.v1.endUsers.create({
      attributes: {
        business_title: rep.businessTitle,
        email: rep.email,
        first_name: rep.firstName,
        job_position: rep.jobPosition,
        last_name: rep.lastName,
        phone_number: rep.phone,
      },
      friendlyName: `${common.legalBusinessName} authorized representative`,
      type: "authorized_representative_1",
    });
    registration.authorizedRepresentativeSid = representative.sid;
    await saveStateDocument(registration);
    await assignCustomerProfileObject(client, registration.customerProfileSid, representative.sid);
  }

  const addressWasMissing = !registration.addressDocumentSid;
  await ensureAddressResources({ client, registration, legalBusinessName: common.legalBusinessName, address });
  if (addressWasMissing) {
    await assignCustomerProfileObject(client, registration.customerProfileSid, registration.addressDocumentSid);
  }

  if (!registration.customerProfileStatus || registration.customerProfileStatus === "draft") {
    // Linking the parent ISV profile is required for a Secondary Customer Profile.
    try {
      await assignCustomerProfileObject(client, registration.customerProfileSid, primaryCustomerProfileSid);
    } catch (error) {
      // Treat already-assigned responses as idempotent. Twilio codes vary by resource.
      if (![409, 20409].includes(Number(error?.status || error?.code))) throw error;
    }
    await evaluateCustomerProfile(client, registration.customerProfileSid, STANDARD_CUSTOMER_PROFILE_POLICY_SID);
    const submitted = await client.trusthub.v1
      .customerProfiles(registration.customerProfileSid)
      .update({ status: "pending-review" });
    registration.customerProfileStatus = submitted.status || "pending-review";
    await saveStateDocument(registration);
  }

  if (!registration.trustProductSid) {
    const trustProduct = await client.trusthub.v1.trustProducts.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} A2P Trust Product`,
      policySid: STANDARD_A2P_TRUST_POLICY_SID,
    });
    registration.trustProductSid = trustProduct.sid;
    registration.trustProductStatus = trustProduct.status || "draft";
    await saveStateDocument(registration);
  }

  if (!registration.messagingProfileEndUserSid) {
    const messagingEndUser = await client.trusthub.v1.endUsers.create({
      attributes: { company_type: clean(input.companyType || "private") },
      friendlyName: `${common.legalBusinessName} A2P messaging profile`,
      type: "us_a2p_messaging_profile_information",
    });
    registration.messagingProfileEndUserSid = messagingEndUser.sid;
    await saveStateDocument(registration);
    await assignTrustProductObject(client, registration.trustProductSid, messagingEndUser.sid);
    await assignTrustProductObject(client, registration.trustProductSid, registration.customerProfileSid);
  }

  if (!registration.trustProductStatus || registration.trustProductStatus === "draft") {
    await evaluateTrustProduct(client, registration.trustProductSid, STANDARD_A2P_TRUST_POLICY_SID);
    const submittedTrust = await client.trusthub.v1
      .trustProducts(registration.trustProductSid)
      .update({ status: "pending-review" });
    registration.trustProductStatus = submittedTrust.status || "pending-review";
    await saveStateDocument(registration);
  }

  if (!registration.brandSid) {
    const brand = await client.messaging.v1.brandRegistrations.create({
      a2PProfileBundleSid: registration.trustProductSid,
      customerProfileBundleSid: registration.customerProfileSid,
      ...(common.registrationType === "low_volume_standard"
        ? { skipAutomaticSecVet: true }
        : {}),
    });
    registration.brandSid = brand.sid;
    registration.brandStatus = brand.status || "PENDING";
    registration.brandIdentityStatus = brand.identityStatus || "";
    await saveStateDocument(registration);
  }

  await ensureMessagingService({ client, registration, businessName: common.legalBusinessName });
};

const createSoleProprietorRegistration = async ({ client, registration, input, common }) => {
  const primaryCustomerProfileSid = getPrimaryCustomerProfileSid();
  const notificationEmail = getNotificationEmail();
  const address = validateAddress(input.address);
  const mobilePhone = normalizePhone(input.contact?.mobilePhone);
  if (!mobilePhone) throw new Error("A valid US/Canadian mobile number is required for sole-proprietor OTP verification.");
  if (normalizeEin(input.ein)) {
    throw new Error("Businesses with an EIN must use Standard or Low-Volume Standard A2P registration, not Sole Proprietor.");
  }
  const firstName = clean(input.contact?.firstName);
  const lastName = clean(input.contact?.lastName);
  if (!firstName || !lastName) throw new Error("Owner first and last name are required.");

  registration.registrationType = "sole_proprietor";
  registration.legalBusinessName = common.legalBusinessName;
  registration.businessType = "Sole Proprietorship";
  registration.businessIndustry = upper(input.businessIndustry || "CONSTRUCTION");
  registration.websiteUrl = clean(input.websiteUrl);
  registration.contactEmail = common.contactEmail;
  registration.registrationNumberLast4 = "";
  registration.mobilePhoneLast4 = mobilePhone.slice(-4);
  registration.campaign = {
    description: clean(input.campaign?.description) ||
      `${common.legalBusinessName} uses MeekCall for missed-call recovery and customer-care messaging.`,
    messageFlow: common.campaign.messageFlow,
    messageSamples: createMessageSamples(common.legalBusinessName),
    useCase: "SOLE_PROPRIETOR",
    hasEmbeddedLinks: common.campaign.hasEmbeddedLinks,
    hasEmbeddedPhone: common.campaign.hasEmbeddedPhone,
    privacyPolicyUrl: common.campaign.privacyPolicyUrl,
    termsAndConditionsUrl: common.campaign.termsAndConditionsUrl,
  };
  await saveStateDocument(registration);

  if (!registration.customerProfileSid) {
    const profile = await client.trusthub.v1.customerProfiles.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} Starter Customer Profile`,
      policySid: SOLE_PROP_CUSTOMER_PROFILE_POLICY_SID,
    });
    registration.customerProfileSid = profile.sid;
    registration.customerProfileStatus = profile.status || "draft";
    await saveStateDocument(registration);
  }

  if (!registration.businessEndUserSid) {
    const starterEndUser = await client.trusthub.v1.endUsers.create({
      attributes: {
        email: common.contactEmail,
        first_name: firstName,
        last_name: lastName,
        phone_number: common.contactPhone,
      },
      friendlyName: `${common.legalBusinessName} starter profile information`,
      type: "starter_customer_profile_information",
    });
    registration.businessEndUserSid = starterEndUser.sid;
    await saveStateDocument(registration);
    await assignCustomerProfileObject(client, registration.customerProfileSid, starterEndUser.sid);
  }

  const addressWasMissing = !registration.addressDocumentSid;
  await ensureAddressResources({ client, registration, legalBusinessName: common.legalBusinessName, address });
  if (addressWasMissing) {
    await assignCustomerProfileObject(client, registration.customerProfileSid, registration.addressDocumentSid);
  }

  if (!registration.customerProfileStatus || registration.customerProfileStatus === "draft") {
    try {
      await assignCustomerProfileObject(client, registration.customerProfileSid, primaryCustomerProfileSid);
    } catch (error) {
      if (![409, 20409].includes(Number(error?.status || error?.code))) throw error;
    }
    await evaluateCustomerProfile(client, registration.customerProfileSid, SOLE_PROP_CUSTOMER_PROFILE_POLICY_SID);
    const submitted = await client.trusthub.v1
      .customerProfiles(registration.customerProfileSid)
      .update({ status: "pending-review" });
    registration.customerProfileStatus = submitted.status || "pending-review";
    await saveStateDocument(registration);
  }

  if (!registration.trustProductSid) {
    const trustProduct = await client.trusthub.v1.trustProducts.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} Sole Proprietor A2P Trust Bundle`,
      policySid: SOLE_PROP_A2P_TRUST_POLICY_SID,
    });
    registration.trustProductSid = trustProduct.sid;
    registration.trustProductStatus = trustProduct.status || "draft";
    await saveStateDocument(registration);
  }

  if (!registration.messagingProfileEndUserSid) {
    const soleEndUser = await client.trusthub.v1.endUsers.create({
      attributes: {
        brand_name: common.legalBusinessName,
        mobile_phone_number: mobilePhone,
        vertical: registration.businessIndustry,
      },
      friendlyName: `${common.legalBusinessName} sole proprietor A2P information`,
      type: "sole_proprietor_information",
    });
    registration.messagingProfileEndUserSid = soleEndUser.sid;
    await saveStateDocument(registration);
    await assignTrustProductObject(client, registration.trustProductSid, soleEndUser.sid);
    await assignTrustProductObject(client, registration.trustProductSid, registration.customerProfileSid);
  }

  if (!registration.trustProductStatus || registration.trustProductStatus === "draft") {
    await evaluateTrustProduct(client, registration.trustProductSid, SOLE_PROP_A2P_TRUST_POLICY_SID);
    const submittedTrust = await client.trusthub.v1
      .trustProducts(registration.trustProductSid)
      .update({ status: "pending-review" });
    registration.trustProductStatus = submittedTrust.status || "pending-review";
    await saveStateDocument(registration);
  }

  if (!registration.brandSid) {
    const brand = await client.messaging.v1.brandRegistrations.create({
      a2PProfileBundleSid: registration.trustProductSid,
      brandType: "SOLE_PROPRIETOR",
      customerProfileBundleSid: registration.customerProfileSid,
    });
    registration.brandSid = brand.sid;
    registration.brandStatus = brand.status || "PENDING";
    registration.brandIdentityStatus = brand.identityStatus || "UNVERIFIED";
    await saveStateDocument(registration);
  }

  await ensureMessagingService({ client, registration, businessName: common.legalBusinessName });
};

export const startA2pCustomerRegistration = async ({ businessId, input, client = null }) => {
  const common = validateCommon(input);
  const twilioClient = client || getTwilioClient();
  let registration = await getRegistrationWithSecrets(businessId);
  if (!registration) registration = new A2pCustomerRegistration({ business: businessId });
  if (registration.brandSid && registration.registrationType !== common.registrationType) {
    throw new Error("This business already has an A2P Brand. Registration type cannot be changed without compliance remediation.");
  }

  try {
    if (common.registrationType === "sole_proprietor") {
      await createSoleProprietorRegistration({ client: twilioClient, registration, input, common });
    } else {
      await createStandardRegistration({ client: twilioClient, registration, input, common });
    }
    registration.status = "brand_pending";
    registration.submittedAt ||= new Date();
    registration.lastSyncedAt = new Date();
    registration.lastError = "";
    await saveStateDocument(registration);
    return toPublicA2pRegistration(registration);
  } catch (error) {
    registration.status = "action_required";
    registration.lastError = `${error?.code ? `${error.code}: ` : ""}${error?.message || error}`.slice(0, 2000);
    registration.lastSyncedAt = new Date();
    await saveStateDocument(registration).catch(() => {});
    throw error;
  }
};

const campaignReadyForCreation = (registration) => {
  const brandApproved = upper(registration.brandStatus) === "APPROVED";
  if (!brandApproved) return false;
  if (registration.registrationType === "sole_proprietor") {
    return upper(registration.brandIdentityStatus) === "VERIFIED";
  }
  return true;
};

const createCampaign = async ({ client, registration }) => {
  if (registration.campaignSid || !campaignReadyForCreation(registration)) return;
  const data = registration.campaign || {};
  const campaign = await client.messaging.v1
    .services(registration.messagingServiceSid)
    .usAppToPerson.create({
      brandRegistrationSid: registration.brandSid,
      description: clean(data.description),
      hasEmbeddedLinks: Boolean(data.hasEmbeddedLinks),
      hasEmbeddedPhone: Boolean(data.hasEmbeddedPhone),
      messageFlow: clean(data.messageFlow),
      messageSamples: Array.isArray(data.messageSamples) ? data.messageSamples.slice(0, 5) : [],
      privacyPolicyUrl: clean(data.privacyPolicyUrl),
      termsAndConditionsUrl: clean(data.termsAndConditionsUrl),
      usAppToPersonUsecase:
        registration.registrationType === "sole_proprietor" ? "SOLE_PROPRIETOR" : "CUSTOMER_CARE",
    });
  registration.campaignSid = campaign.sid;
  registration.campaignStatus = campaign.campaignStatus || campaign.status || "PENDING";
  registration.campaignCreatedAt = new Date();
  registration.status = "campaign_pending";
  await saveStateDocument(registration);
};

export const syncA2pCustomerRegistration = async ({ businessId, client = null }) => {
  const registration = await getRegistrationWithSecrets(businessId);
  if (!registration) return toPublicA2pRegistration(null);
  const twilioClient = client || getTwilioClient();

  try {
    if (registration.customerProfileSid) {
      const profile = await twilioClient.trusthub.v1.customerProfiles(registration.customerProfileSid).fetch();
      registration.customerProfileStatus = profile.status || registration.customerProfileStatus;
    }
    if (registration.trustProductSid) {
      const trust = await twilioClient.trusthub.v1.trustProducts(registration.trustProductSid).fetch();
      registration.trustProductStatus = trust.status || registration.trustProductStatus;
    }
    if (registration.brandSid) {
      const brand = await twilioClient.messaging.v1.brandRegistrations(registration.brandSid).fetch();
      registration.brandStatus = brand.status || registration.brandStatus;
      registration.brandIdentityStatus = brand.identityStatus || registration.brandIdentityStatus;
      const brandStatus = upper(registration.brandStatus);
      if (["FAILED", "SUSPENDED", "EXPIRED"].includes(brandStatus)) {
        registration.status = "action_required";
        registration.lastError = clean(brand.failureReason || brand.errors || "A2P Brand requires remediation.").slice(0, 2000);
      } else if (brandStatus === "APPROVED") {
        registration.brandApprovedAt ||= new Date();
        if (
          registration.registrationType === "sole_proprietor" &&
          upper(registration.brandIdentityStatus) !== "VERIFIED"
        ) {
          registration.status = "otp_required";
          registration.otpStatus = "awaiting_yes_reply";
        } else if (!registration.campaignSid) {
          registration.status = "brand_approved";
        }
      } else {
        registration.status = "brand_pending";
      }
    }

    if (registration.messagingServiceSid) {
      await createCampaign({ client: twilioClient, registration });
    }

    if (registration.campaignSid) {
      const campaign = await twilioClient.messaging.v1
        .services(registration.messagingServiceSid)
        .usAppToPerson(registration.campaignSid)
        .fetch();
      registration.campaignStatus = campaign.campaignStatus || campaign.status || registration.campaignStatus;
      const campaignStatus = upper(registration.campaignStatus);
      if (["FAILED", "REJECTED", "SUSPENDED"].includes(campaignStatus)) {
        registration.status = "action_required";
        registration.lastError = clean(campaign.failureReason || campaign.errors || "A2P Campaign requires remediation.").slice(0, 2000);
      } else if (campaignStatus === "VERIFIED") {
        const business = await Business.findById(businessId).select(
          "+trackingNumber.providerSid +messagingCompliance.messagingServiceSid",
        );
        if (business?.trackingNumber?.providerSid) {
          const state = await attachPhoneNumberToBusinessMessagingRegistration({
            client: twilioClient,
            business,
            phoneNumberSid: business.trackingNumber.providerSid,
          });
          await Business.updateOne({ _id: businessId }, { $set: toMessagingComplianceUpdate(state) });
          registration.numberAttachedAt ||= new Date();
        }
        if (registration.status !== "ready") {
          registration.status = "number_pending";
          registration.numberStatus ||= "PENDING_REGISTRATION";
        }
      } else {
        registration.status = "campaign_pending";
      }
    }

    registration.lastSyncedAt = new Date();
    if (registration.status !== "action_required") registration.lastError = "";
    await saveStateDocument(registration);
    return toPublicA2pRegistration(registration);
  } catch (error) {
    registration.lastSyncedAt = new Date();
    registration.lastError = `${error?.code ? `${error.code}: ` : ""}${error?.message || error}`.slice(0, 2000);
    if (!registration.brandSid) registration.status = "action_required";
    await saveStateDocument(registration).catch(() => {});
    throw error;
  }
};

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const a2pServiceError = (code, message, statusCode = 400, extra = {}) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
};

const reserveOtpRetry = async (registration) => {
  const now = new Date();
  const cooldownMs = positiveInteger(
    process.env.A2P_OTP_RETRY_COOLDOWN_MS,
    90_000,
  );
  const windowMs = positiveInteger(
    process.env.A2P_OTP_RETRY_WINDOW_MS,
    60 * 60 * 1000,
  );
  const maxPerWindow = positiveInteger(
    process.env.A2P_OTP_RETRY_MAX_PER_WINDOW,
    5,
  );
  const cooldownCutoff = new Date(now.getTime() - cooldownMs);
  const windowCutoff = new Date(now.getTime() - windowMs);

  const identity = {
    _id: registration._id,
    registrationType: "sole_proprietor",
    brandSid: registration.brandSid,
  };
  const cooldown = {
    $or: [
      { otpRequestedAt: null },
      { otpRequestedAt: { $exists: false } },
      { otpRequestedAt: { $lte: cooldownCutoff } },
    ],
  };

  let reserved = await A2pCustomerRegistration.findOneAndUpdate(
    {
      $and: [
        identity,
        cooldown,
        {
          $or: [
            { otpRetryWindowStartedAt: null },
            { otpRetryWindowStartedAt: { $exists: false } },
            { otpRetryWindowStartedAt: { $lte: windowCutoff } },
          ],
        },
      ],
    },
    {
      $set: {
        otpRequestedAt: now,
        otpRetryWindowStartedAt: now,
        otpRetryCount: 1,
      },
    },
    { returnDocument: "after" },
  ).select(selectSecrets);

  if (!reserved) {
    reserved = await A2pCustomerRegistration.findOneAndUpdate(
      {
        $and: [
          identity,
          cooldown,
          { otpRetryWindowStartedAt: { $gt: windowCutoff } },
          { otpRetryCount: { $lt: maxPerWindow } },
        ],
      },
      {
        $set: { otpRequestedAt: now },
        $inc: { otpRetryCount: 1 },
      },
      { returnDocument: "after" },
    ).select(selectSecrets);
  }

  if (reserved) return reserved;

  const latest = await getRegistrationWithSecrets(registration.business);
  const lastRequestedAt = latest?.otpRequestedAt
    ? new Date(latest.otpRequestedAt)
    : null;
  const windowStartedAt = latest?.otpRetryWindowStartedAt
    ? new Date(latest.otpRetryWindowStartedAt)
    : null;

  if (
    lastRequestedAt &&
    now.getTime() - lastRequestedAt.getTime() < cooldownMs
  ) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (lastRequestedAt.getTime() + cooldownMs - now.getTime()) / 1000,
      ),
    );
    throw a2pServiceError(
      "A2P_OTP_RETRY_COOLDOWN",
      `Wait ${retryAfterSeconds} seconds before requesting another verification code.`,
      429,
      { retryAfterSeconds },
    );
  }

  const retryAfterSeconds = windowStartedAt
    ? Math.max(
        1,
        Math.ceil(
          (windowStartedAt.getTime() + windowMs - now.getTime()) / 1000,
        ),
      )
    : Math.ceil(windowMs / 1000);

  throw a2pServiceError(
    "A2P_OTP_RETRY_LIMIT",
    "Too many verification-code requests. Try again later.",
    429,
    { retryAfterSeconds },
  );
};

export const retrySoleProprietorOtp = async ({ businessId, client = null }) => {
  const registration = await getRegistrationWithSecrets(businessId);
  if (!registration?.brandSid || registration.registrationType !== "sole_proprietor") {
    throw a2pServiceError(
      "A2P_OTP_NOT_AVAILABLE",
      "No Sole Proprietor Brand is available for OTP verification.",
      400,
    );
  }

  const reserved = await reserveOtpRetry(registration);
  const twilioClient = client || getTwilioClient();

  try {
    await twilioClient.messaging.v1
      .brandRegistrations(reserved.brandSid)
      .brandRegistrationOtps.create();

    reserved.otpStatus = "awaiting_yes_reply";
    reserved.status = "otp_required";
    reserved.lastError = "";
    await saveStateDocument(reserved);
    return toPublicA2pRegistration(reserved);
  } catch (error) {
    reserved.lastError = "Unable to request another verification code.";
    await saveStateDocument(reserved).catch(() => {});
    throw error;
  }
};

const findRegistrationForNumberEvent = async ({
  phoneNumberSid,
  messagingServiceSid,
  campaignSid,
}) => {
  const registrationChecks = [
    ...(campaignSid ? [{ campaignSid }] : []),
    ...(messagingServiceSid ? [{ messagingServiceSid }] : []),
  ];

  let registration = registrationChecks.length
    ? await A2pCustomerRegistration.findOne({
        $or: registrationChecks,
      }).select(selectSecrets)
    : null;

  if (!registration && phoneNumberSid) {
    const business = await Business.findOne({
      "trackingNumber.providerSid": phoneNumberSid,
    })
      .select("_id")
      .lean();

    if (business?._id) {
      registration = await A2pCustomerRegistration.findOne({
        business: business._id,
      }).select(selectSecrets);
    }
  }

  return registration;
};

export const markNumberRegistrationEvent = async ({
  phoneNumberSid,
  messagingServiceSid,
  campaignSid,
  externalStatus,
  failureReason = "",
  eventType = "",
  eventId = "",
  eventAt = null,
}) => {
  const found = await findRegistrationForNumberEvent({
    phoneNumberSid,
    messagingServiceSid,
    campaignSid,
  });
  if (!found) return null;

  let lease = null;
  try {
    lease = await acquireOperationLease({
      key: `a2p-compliance-event:${found.business}`,
      ttlMs: Number(process.env.A2P_EVENT_PROCESSING_LEASE_MS || 30_000),
      busyCode: "A2P_EVENT_PROCESSING_BUSY",
      busyMessage: "Another compliance event is being processed for this business.",
      busyStatusCode: 503,
    });

    const registration = await A2pCustomerRegistration.findById(found._id).select(
      selectSecrets,
    );
    if (!registration) return null;

    const status = resolveNumberLifecycleStatus({
      eventType,
      externalStatus,
    });
    const eventRank = numberLifecycleRank(status);
    const normalizedEventAt = parseEventDate(eventAt);
    const ignoreReason = shouldIgnoreNumberLifecycleEvent({
      lastEventId: registration.lastNumberEventId,
      lastEventAt: registration.lastNumberEventAt,
      lastEventRank: registration.lastNumberEventRank,
      eventId: clean(eventId),
      eventAt: normalizedEventAt,
      eventRank,
    });

    if (ignoreReason) {
      return {
        registration,
        phoneNumberSid,
        ignored: true,
        reason: ignoreReason,
      };
    }

    const now = new Date();
    registration.numberStatus = status;
    registration.lastSyncedAt = now;
    registration.lastNumberEventId = clean(eventId);
    registration.lastNumberEventAt = normalizedEventAt || now;
    registration.lastNumberEventRank = eventRank;

    let businessSet = {
      "messagingCompliance.lastCheckedAt": now,
    };

    if (status === "REGISTERED") {
      registration.status = "ready";
      registration.approvedAt ||= now;
      registration.lastError = "";
      businessSet = {
        ...businessSet,
        "messagingCompliance.a2pStatus": "registered",
        "messagingCompliance.campaignStatus": "VERIFIED",
        "messagingCompliance.smsReady": true,
        "messagingCompliance.senderAttached": true,
        "messagingCompliance.senderAttachedAt": now,
        "messagingCompliance.lastError": "",
      };
    } else if (status === "DEREGISTERED") {
      registration.status = "action_required";
      registration.lastError = clean(
        failureReason ||
          "The tracking number is no longer registered for A2P messaging.",
      ).slice(0, 2000);
      businessSet = {
        ...businessSet,
        "messagingCompliance.a2pStatus": "failed",
        "messagingCompliance.smsReady": false,
        "messagingCompliance.senderAttached": false,
        "messagingCompliance.senderAttachedAt": null,
        "messagingCompliance.lastError":
          "Messaging registration needs attention. Review A2P status or contact support.",
      };
    } else if (status === "PENDING_DEREGISTRATION") {
      registration.status = "number_pending";
      registration.lastError =
        "Carrier deregistration is pending. SMS is disabled until the number is registered again.";
      businessSet = {
        ...businessSet,
        "messagingCompliance.a2pStatus": "pending",
        "messagingCompliance.smsReady": false,
        "messagingCompliance.lastError": registration.lastError,
      };
    } else if (
      status === "FAILURE" ||
      status === "FAILED" ||
      status === "DEREGISTRATION_FAILED"
    ) {
      registration.status = "action_required";
      registration.lastError = clean(
        failureReason ||
          (status === "DEREGISTRATION_FAILED"
            ? "Carrier deregistration could not be reconciled. SMS remains disabled until status is confirmed."
            : "Phone-number carrier registration failed."),
      ).slice(0, 2000);
      businessSet = {
        ...businessSet,
        "messagingCompliance.a2pStatus": "failed",
        "messagingCompliance.smsReady": false,
        "messagingCompliance.lastError":
          "Messaging registration needs attention. Review A2P status or contact support.",
      };
    } else {
      registration.status = "number_pending";
      registration.lastError = "";
      businessSet = {
        ...businessSet,
        "messagingCompliance.a2pStatus": "pending",
        "messagingCompliance.smsReady": false,
        "messagingCompliance.lastError": "",
      };
    }

    await Business.updateOne(
      { _id: registration.business },
      { $set: businessSet },
    );
    await saveStateDocument(registration);

    return { registration, phoneNumberSid, ignored: false };
  } finally {
    await releaseOperationLease(lease);
  }
};

export const markComplianceEvent = async ({
  type,
  data = {},
  eventId = "",
  eventAt = null,
  client = null,
}) => {
  const normalizedType = clean(type).toLowerCase();
  const brandSid = clean(
    data.brandsid ||
      data.brandSid ||
      data.brand_sid ||
      data.brand_registration_sid,
  );
  const campaignSid = clean(
    data.campaignsid || data.campaignSid || data.campaign_sid,
  );
  const messagingServiceSid = clean(
    data.messagingservicesid ||
      data.messagingServiceSid ||
      data.messaging_service_sid,
  );
  const phoneNumberSid = clean(
    data.phonenumbersid || data.phoneNumberSid || data.phone_number_sid,
  );
  const externalStatus = clean(
    data.externalstatus || data.externalStatus || data.external_status,
  );
  const failureReason = clean(
    data.failurereason || data.failureReason || data.failure_reason,
  );

  if (
    normalizedType.includes("number-registration.") ||
    normalizedType.includes("number-deregistration.")
  ) {
    return markNumberRegistrationEvent({
      phoneNumberSid,
      messagingServiceSid,
      campaignSid,
      externalStatus,
      failureReason,
      eventType: normalizedType,
      eventId,
      eventAt,
    });
  }

  let registration = null;
  if (brandSid) {
    registration = await A2pCustomerRegistration.findOne({ brandSid }).select(
      selectSecrets,
    );
  }
  if (!registration && campaignSid) {
    registration = await A2pCustomerRegistration.findOne({ campaignSid }).select(
      selectSecrets,
    );
  }
  if (!registration && messagingServiceSid) {
    registration = await A2pCustomerRegistration.findOne({
      messagingServiceSid,
    }).select(selectSecrets);
  }
  if (!registration) return null;

  if (
    normalizedType.includes("brand-failure") ||
    normalizedType.includes("brand-unverified")
  ) {
    registration.status = "action_required";
    registration.lastError =
      failureReason || "Twilio reported an A2P Brand verification problem.";
    await saveStateDocument(registration);
    return registration;
  }

  if (normalizedType.includes("campaign-failure")) {
    registration.status = "action_required";
    registration.lastError =
      failureReason || "Twilio reported an A2P Campaign verification problem.";
    await saveStateDocument(registration);
    return registration;
  }

  return syncA2pCustomerRegistration({
    businessId: registration.business,
    client,
  });
};
