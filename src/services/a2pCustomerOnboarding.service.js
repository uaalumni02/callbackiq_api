import twilio from "twilio";

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

const REGISTRATION_TYPES = new Set([
  "standard",
  "low_volume_standard",
  "sole_proprietor",
]);
const BUSINESS_TYPES = new Set([
  "Co-operative",
  "Corporation",
  "Limited Liability Corporation",
  "Non-profit Corporation",
  "Partnership",
  "Sole Proprietorship",
]);

const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();
const normalizePhone = (value) => {
  const raw = clean(value);
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
};
const normalizeEin = (value) => clean(value).replace(/\D/g, "");
const isHttpUrl = (value) => {
  try {
    const url = new URL(clean(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
};

const env = (name) => clean(process.env[name]);
const requiredEnv = (name) => {
  const value = env(name);
  if (!value) throw new Error(`${name} is required for automated A2P onboarding.`);
  return value;
};

export const getTwilioClient = () =>
  twilio(requiredEnv("TWILIO_ACCOUNT_SID"), requiredEnv("TWILIO_AUTH_TOKEN"));

const getNotificationEmail = () => requiredEnv("A2P_NOTIFICATION_EMAIL");
const getPrimaryCustomerProfileSid = () => requiredEnv("TWILIO_PRIMARY_CUSTOMER_PROFILE_SID");

const getPublicWebhookBaseUrl = () =>
  clean(
    process.env.TWILIO_WEBHOOK_BASE_URL ||
      process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.API_PUBLIC_URL,
  ).replace(/\/+$/, "");

const formatEvaluationFailure = (evaluation) => {
  const failures = Array.isArray(evaluation?.results)
    ? evaluation.results
        .filter((result) => result?.passed === false || result?.failureReason || result?.failure_reason)
        .map(
          (result) =>
            result?.failureReason ||
            result?.failure_reason ||
            result?.friendlyName ||
            result?.friendly_name,
        )
        .filter(Boolean)
    : [];
  return failures.length
    ? failures.join(" | ").slice(0, 1900)
    : "Twilio reported that the submitted compliance bundle is noncompliant.";
};

const createMessageSamples = (brand) => [
  `Hi, this is ${brand}. Sorry we missed your call. Reply with the service you need and we'll help with the next step. Reply STOP to opt out.`,
  `Thanks for contacting ${brand}. What service do you need and what ZIP code is the job in? Reply STOP to opt out.`,
];

const validateCampaign = (campaign = {}) => {
  const messageFlow = clean(campaign.messageFlow);
  const privacyPolicyUrl = clean(campaign.privacyPolicyUrl);
  const termsAndConditionsUrl = clean(campaign.termsAndConditionsUrl);
  if (messageFlow.length < 40) {
    throw new Error("Describe how customers consent to receive CallBackIQ SMS messages (at least 40 characters). ");
  }
  if (!isHttpUrl(privacyPolicyUrl)) throw new Error("A valid customer Privacy Policy URL is required.");
  if (!isHttpUrl(termsAndConditionsUrl)) throw new Error("A valid customer Terms & Conditions URL is required.");
  return {
    messageFlow,
    privacyPolicyUrl,
    termsAndConditionsUrl,
    hasEmbeddedLinks: Boolean(campaign.hasEmbeddedLinks),
    hasEmbeddedPhone: Boolean(campaign.hasEmbeddedPhone),
  };
};

const validateCommon = (input = {}) => {
  const registrationType = clean(input.registrationType || "low_volume_standard");
  if (!REGISTRATION_TYPES.has(registrationType)) throw new Error("Unsupported A2P registration type.");
  const legalBusinessName = clean(input.legalBusinessName);
  if (legalBusinessName.length < 2) throw new Error("Legal business name is required.");
  const contactEmail = clean(input.contact?.email).toLowerCase();
  if (!contactEmail.includes("@")) throw new Error("A valid business contact email is required.");
  const contactPhone = normalizePhone(input.contact?.phone);
  if (!contactPhone) throw new Error("A valid business contact phone is required.");
  const campaign = validateCampaign(input.campaign);
  return { registrationType, legalBusinessName, contactEmail, contactPhone, campaign };
};

const validateAddress = (address = {}) => {
  const result = {
    street: clean(address.street),
    streetSecondary: clean(address.streetSecondary),
    city: clean(address.city),
    region: upper(address.region),
    postalCode: clean(address.postalCode),
    isoCountry: upper(address.isoCountry || "US"),
  };
  if (!result.street || !result.city || !result.region || !result.postalCode) {
    throw new Error("Street, city, state/region, and postal code are required.");
  }
  if (!["US", "CA"].includes(result.isoCountry)) {
    throw new Error("This CallBackIQ A2P onboarding flow currently supports US and Canadian business addresses.");
  }
  return result;
};

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
    friendlyName: `${businessName} - CallBackIQ A2P`,
    ...(webhookBase ? { inboundRequestUrl: `${webhookBase}/api/twilio/sms` } : {}),
  });
  registration.messagingServiceSid = service.sid;
  await registration.save();
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
    await registration.save();
  }
  if (!registration.addressDocumentSid) {
    const document = await client.trusthub.v1.supportingDocuments.create({
      attributes: { address_sids: registration.addressSid },
      friendlyName: `${legalBusinessName} A2P address document`,
      type: "customer_profile_address",
    });
    registration.addressDocumentSid = document.sid;
    await registration.save();
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
      `${common.legalBusinessName} uses CallBackIQ for missed-call recovery and customer-care messaging.`,
    messageFlow: common.campaign.messageFlow,
    messageSamples: createMessageSamples(common.legalBusinessName),
    useCase: "CUSTOMER_CARE",
    hasEmbeddedLinks: common.campaign.hasEmbeddedLinks,
    hasEmbeddedPhone: common.campaign.hasEmbeddedPhone,
    privacyPolicyUrl: common.campaign.privacyPolicyUrl,
    termsAndConditionsUrl: common.campaign.termsAndConditionsUrl,
  };
  await registration.save();

  if (!registration.customerProfileSid) {
    const profile = await client.trusthub.v1.customerProfiles.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} Secondary Customer Profile`,
      policySid: STANDARD_CUSTOMER_PROFILE_POLICY_SID,
    });
    registration.customerProfileSid = profile.sid;
    registration.customerProfileStatus = profile.status || "draft";
    await registration.save();
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
    await registration.save();
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
    await registration.save();
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
    await registration.save();
  }

  if (!registration.trustProductSid) {
    const trustProduct = await client.trusthub.v1.trustProducts.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} A2P Trust Product`,
      policySid: STANDARD_A2P_TRUST_POLICY_SID,
    });
    registration.trustProductSid = trustProduct.sid;
    registration.trustProductStatus = trustProduct.status || "draft";
    await registration.save();
  }

  if (!registration.messagingProfileEndUserSid) {
    const messagingEndUser = await client.trusthub.v1.endUsers.create({
      attributes: { company_type: clean(input.companyType || "private") },
      friendlyName: `${common.legalBusinessName} A2P messaging profile`,
      type: "us_a2p_messaging_profile_information",
    });
    registration.messagingProfileEndUserSid = messagingEndUser.sid;
    await registration.save();
    await assignTrustProductObject(client, registration.trustProductSid, messagingEndUser.sid);
    await assignTrustProductObject(client, registration.trustProductSid, registration.customerProfileSid);
  }

  if (!registration.trustProductStatus || registration.trustProductStatus === "draft") {
    await evaluateTrustProduct(client, registration.trustProductSid, STANDARD_A2P_TRUST_POLICY_SID);
    const submittedTrust = await client.trusthub.v1
      .trustProducts(registration.trustProductSid)
      .update({ status: "pending-review" });
    registration.trustProductStatus = submittedTrust.status || "pending-review";
    await registration.save();
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
    await registration.save();
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
      `${common.legalBusinessName} uses CallBackIQ for missed-call recovery and customer-care messaging.`,
    messageFlow: common.campaign.messageFlow,
    messageSamples: createMessageSamples(common.legalBusinessName),
    useCase: "SOLE_PROPRIETOR",
    hasEmbeddedLinks: common.campaign.hasEmbeddedLinks,
    hasEmbeddedPhone: common.campaign.hasEmbeddedPhone,
    privacyPolicyUrl: common.campaign.privacyPolicyUrl,
    termsAndConditionsUrl: common.campaign.termsAndConditionsUrl,
  };
  await registration.save();

  if (!registration.customerProfileSid) {
    const profile = await client.trusthub.v1.customerProfiles.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} Starter Customer Profile`,
      policySid: SOLE_PROP_CUSTOMER_PROFILE_POLICY_SID,
    });
    registration.customerProfileSid = profile.sid;
    registration.customerProfileStatus = profile.status || "draft";
    await registration.save();
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
    await registration.save();
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
    await registration.save();
  }

  if (!registration.trustProductSid) {
    const trustProduct = await client.trusthub.v1.trustProducts.create({
      email: notificationEmail,
      friendlyName: `${common.legalBusinessName} Sole Proprietor A2P Trust Bundle`,
      policySid: SOLE_PROP_A2P_TRUST_POLICY_SID,
    });
    registration.trustProductSid = trustProduct.sid;
    registration.trustProductStatus = trustProduct.status || "draft";
    await registration.save();
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
    await registration.save();
    await assignTrustProductObject(client, registration.trustProductSid, soleEndUser.sid);
    await assignTrustProductObject(client, registration.trustProductSid, registration.customerProfileSid);
  }

  if (!registration.trustProductStatus || registration.trustProductStatus === "draft") {
    await evaluateTrustProduct(client, registration.trustProductSid, SOLE_PROP_A2P_TRUST_POLICY_SID);
    const submittedTrust = await client.trusthub.v1
      .trustProducts(registration.trustProductSid)
      .update({ status: "pending-review" });
    registration.trustProductStatus = submittedTrust.status || "pending-review";
    await registration.save();
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
    await registration.save();
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
    await registration.save();
    return toPublicA2pRegistration(registration);
  } catch (error) {
    registration.status = "action_required";
    registration.lastError = `${error?.code ? `${error.code}: ` : ""}${error?.message || error}`.slice(0, 2000);
    registration.lastSyncedAt = new Date();
    await registration.save().catch(() => {});
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
  await registration.save();
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
    await registration.save();
    return toPublicA2pRegistration(registration);
  } catch (error) {
    registration.lastSyncedAt = new Date();
    registration.lastError = `${error?.code ? `${error.code}: ` : ""}${error?.message || error}`.slice(0, 2000);
    if (!registration.brandSid) registration.status = "action_required";
    await registration.save().catch(() => {});
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
    { new: true },
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
      { new: true },
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
    await reserved.save();
    return toPublicA2pRegistration(reserved);
  } catch (error) {
    reserved.lastError = "Unable to request another verification code.";
    await reserved.save().catch(() => {});
    throw error;
  }
};

const parseEventDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    // Twilio A2P schemas expose integer timestamps. Accept either Unix seconds
    // or milliseconds so schema-version differences cannot corrupt ordering.
    const millis = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const numericDate = new Date(millis);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const resolveNumberLifecycleStatus = ({
  eventType = "",
  externalStatus = "",
} = {}) => {
  const type = clean(eventType).toLowerCase();
  const supplied = upper(externalStatus);
  const isDeregistration = type.includes("number-deregistration.");

  if (isDeregistration) {
    if (type.endsWith(".successful")) return "DEREGISTERED";
    if (type.endsWith(".pending")) return "PENDING_DEREGISTRATION";
    if (type.endsWith(".failed") || type.endsWith(".failure")) {
      return "DEREGISTRATION_FAILED";
    }
  }

  if (supplied) return supplied;
  if (type.endsWith(".successful")) return "REGISTERED";
  if (type.endsWith(".failed") || type.endsWith(".failure")) return "FAILURE";
  if (type.endsWith(".pending")) return "PENDING_REGISTRATION";
  return "PENDING_REGISTRATION";
};

export const numberLifecycleRank = (status) => {
  switch (upper(status)) {
    case "DEREGISTERED":
      return 100;
    case "FAILURE":
    case "FAILED":
      return 90;
    case "DEREGISTRATION_FAILED":
      return 96;
    case "REGISTERED":
      return 80;
    case "PENDING_DEREGISTRATION":
      return 95;
    default:
      return 10;
  }
};

export const shouldIgnoreNumberLifecycleEvent = ({
  lastEventId = "",
  lastEventAt = null,
  lastEventRank = 0,
  eventId = "",
  eventAt = null,
  eventRank = 0,
} = {}) => {
  if (eventId && lastEventId && eventId === lastEventId) return "duplicate";

  const incomingDate = parseEventDate(eventAt);
  const previousDate = parseEventDate(lastEventAt);

  if (incomingDate && previousDate) {
    if (incomingDate.getTime() < previousDate.getTime()) return "stale";
    if (
      incomingDate.getTime() === previousDate.getTime() &&
      Number(eventRank || 0) < Number(lastEventRank || 0)
    ) {
      return "stale";
    }
  } else if (
    !incomingDate &&
    Number(eventRank || 0) < Number(lastEventRank || 0)
  ) {
    // Fail closed when a malformed/missing timestamp would otherwise downgrade
    // a stronger terminal carrier state.
    return "stale";
  }

  return "";
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
    await registration.save();

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
    await registration.save();
    return registration;
  }

  if (normalizedType.includes("campaign-failure")) {
    registration.status = "action_required";
    registration.lastError =
      failureReason || "Twilio reported an A2P Campaign verification problem.";
    await registration.save();
    return registration;
  }

  return syncA2pCustomerRegistration({
    businessId: registration.business,
    client,
  });
};
