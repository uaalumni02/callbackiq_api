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


export { clean, upper, normalizePhone, normalizeEin, isHttpUrl, formatEvaluationFailure, createMessageSamples, validateCommon, validateAddress, BUSINESS_TYPES };
