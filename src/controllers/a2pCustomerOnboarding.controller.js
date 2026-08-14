import Business from "../models/business.js";
import {
  getRegistrationWithSecrets,
  retrySoleProprietorOtp,
  startA2pCustomerRegistration,
  syncA2pCustomerRegistration,
  toPublicA2pRegistration,
} from "../services/a2pCustomerOnboarding.service.js";

const ownerIdFrom = (req) => req.user?.userId || req.user?._id || req.user?.id;

const findBusiness = async (req) => {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return null;
  return Business.findOne({ owner: ownerId });
};

const SAFE_VALIDATION_MESSAGES = new Set([
  "A valid customer Privacy Policy URL is required.",
  "A valid customer Terms & Conditions URL is required.",
  "Unsupported A2P registration type.",
  "Legal business name is required.",
  "A valid business contact email is required.",
  "A valid business contact phone is required.",
  "Street, city, state/region, and postal code are required.",
  "This CallBackIQ A2P onboarding flow currently supports US and Canadian business addresses.",
  "This automated Standard/Low-Volume Standard flow currently supports U.S. EIN-based businesses only.",
  "A valid 9-digit EIN is required for Standard/Low-Volume Standard A2P registration.",
  "Select a valid legal business type.",
  "A valid business website URL is required.",
  "Authorized representative first and last name are required.",
  "A valid US/Canadian mobile number is required for sole-proprietor OTP verification.",
  "Businesses with an EIN must use Standard or Low-Volume Standard A2P registration, not Sole Proprietor.",
  "Owner first and last name are required.",
  "This business already has an A2P Brand. Registration type cannot be changed without compliance remediation.",
]);

const isSafeValidationMessage = (message) => {
  const value = String(message || "").trim();
  return (
    SAFE_VALIDATION_MESSAGES.has(value) ||
    value.startsWith(
      "Describe how customers consent to receive CallBackIQ SMS messages",
    )
  );
};

const SAFE_APP_MESSAGES = {
  A2P_OTP_NOT_AVAILABLE:
    "No Sole Proprietor Brand is available for OTP verification.",
  A2P_OTP_RETRY_COOLDOWN:
    "Please wait before requesting another verification code.",
  A2P_OTP_RETRY_LIMIT:
    "Too many verification-code requests. Try again later.",
  A2P_CUSTOMER_PROFILE_NONCOMPLIANT:
    "Business verification needs attention. Review the registration details and try again.",
  A2P_TRUST_PRODUCT_NONCOMPLIANT:
    "Messaging verification needs attention. Review the registration details and try again.",
};

const respondError = (res, error) => {
  const rawMessage = String(
    error?.message || "Unable to complete messaging registration.",
  ).trim();
  const candidateCode =
    typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : "";
  const safeCode = Object.prototype.hasOwnProperty.call(
    SAFE_APP_MESSAGES,
    candidateCode,
  )
    ? candidateCode
    : "";
  const explicitStatus = Number(error?.statusCode || 0);
  const localValidation = !error?.code && isSafeValidationMessage(rawMessage);
  const status =
    explicitStatus >= 400 && explicitStatus <= 599
      ? explicitStatus
      : localValidation
        ? 400
        : 502;

  let message = SAFE_APP_MESSAGES[safeCode] || "";
  if (!message && localValidation && status < 500) message = rawMessage;
  if (!message) {
    message =
      status === 429
        ? "Too many messaging-verification requests. Try again later."
        : "Unable to complete messaging registration. Please try again or contact support.";
  }

  if (status === 429 && Number(error?.retryAfterSeconds) > 0) {
    res.set("Retry-After", String(Math.ceil(error.retryAfterSeconds)));
  }

  return res.status(status).json({
    success: false,
    message,
    ...(safeCode ? { code: safeCode } : {}),
  });
};
export const getA2pRegistration = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const registration = await getRegistrationWithSecrets(business._id);
    return res.status(200).json({ success: true, data: toPublicA2pRegistration(registration) });
  } catch (error) {
    return respondError(res, error);
  }
};

export const submitA2pRegistration = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const data = await startA2pCustomerRegistration({ businessId: business._id, input: req.body || {} });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

export const syncA2pRegistration = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const data = await syncA2pCustomerRegistration({ businessId: business._id });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

export const retryA2pOtp = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const data = await retrySoleProprietorOtp({ businessId: business._id });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};
