import crypto from "crypto";

import Business from "../models/business.js";
import SecurityAlertService from "./securityAlert.service.js";
import { securityGateEnabled } from "./trialIdentityVerification.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const safeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 120);

const riskSalt = () =>
  String(
    process.env.TRIAL_RISK_HASH_SALT ||
      process.env.JWT_SECRET ||
      "callbackiq-development-risk-salt",
  );

const hashSignal = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return crypto
    .createHmac("sha256", riskSalt())
    .update(normalized)
    .digest("hex");
};

const requestIp = (req) =>
  String(req?.ip || req?.socket?.remoteAddress || "").trim();

export const captureSignupSecurity = (req, businessName = "") => ({
  ipHash: hashSignal(requestIp(req)),
  userAgentHash: hashSignal(req?.headers?.["user-agent"] || ""),
  businessNameKey: safeKey(businessName),
});

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const assessTrialActivationRisk = async ({ business }) => {
  const stored = await Business.findById(business?._id)
    .select("+signupSecurity.ipHash +signupSecurity.userAgentHash signupSecurity.businessNameKey")
    .lean();

  if (!stored) {
    return { score: 0, signals: [], reviewRequired: false };
  }

  const cutoff = new Date(Date.now() - DAY_MS);
  const security = stored.signupSecurity || {};
  const filters = {
    createdAt: { $gte: cutoff },
    _id: { $ne: stored._id },
  };

  const [sameIp, sameUserAgent, sameBusinessName] = await Promise.all([
    security.ipHash
      ? Business.countDocuments({
          ...filters,
          "signupSecurity.ipHash": security.ipHash,
        })
      : Promise.resolve(0),
    security.userAgentHash
      ? Business.countDocuments({
          ...filters,
          "signupSecurity.userAgentHash": security.userAgentHash,
        })
      : Promise.resolve(0),
    security.businessNameKey
      ? Business.countDocuments({
          ...filters,
          "signupSecurity.businessNameKey": security.businessNameKey,
        })
      : Promise.resolve(0),
  ]);

  let score = 0;
  const signals = [];

  if (sameIp >= 2) {
    score += 35;
    signals.push({ type: "shared_signup_ip", count: sameIp + 1 });
  } else if (sameIp === 1) {
    score += 15;
    signals.push({ type: "shared_signup_ip", count: 2 });
  }

  if (sameUserAgent >= 4) {
    score += 25;
    signals.push({
      type: "shared_user_agent",
      count: sameUserAgent + 1,
    });
  } else if (sameUserAgent >= 2) {
    score += 10;
    signals.push({
      type: "shared_user_agent",
      count: sameUserAgent + 1,
    });
  }

  if (sameBusinessName >= 1) {
    score += 35;
    signals.push({
      type: "repeated_business_name",
      count: sameBusinessName + 1,
    });
  }

  const threshold = positiveInteger(
    process.env.TRIAL_RISK_REVIEW_THRESHOLD,
    70,
  );

  return {
    score,
    threshold,
    signals,
    reviewRequired: score >= threshold && signals.length >= 2,
  };
};

export const enforceTrialActivationRisk = async ({ business }) => {
  if (
    !securityGateEnabled("TRIAL_RISK_SCORING_ENABLED", {
      productionDefault: true,
    })
  ) {
    return { score: 0, signals: [], reviewRequired: false, skipped: true };
  }

  const assessment = await assessTrialActivationRisk({ business });

  if (!assessment.reviewRequired) return assessment;

  void SecurityAlertService.dispatch(
    "trial_risk_review_required",
    {
      businessId: String(business._id),
      score: assessment.score,
      threshold: assessment.threshold,
      signals: assessment.signals,
    },
    "warn",
  ).catch(() => {});

  const error = new Error(
    "We could not automatically approve this free-trial activation. Contact support or choose a paid plan.",
  );
  error.code = "TRIAL_RISK_REVIEW_REQUIRED";
  error.statusCode = 403;
  error.riskAssessment = assessment;
  throw error;
};

export default {
  captureSignupSecurity,
  assessTrialActivationRisk,
  enforceTrialActivationRisk,
};
