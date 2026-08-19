import Business from "../models/business.js";
import SecurityAlertService from "./securityAlert.service.js";
import { securityGateEnabled } from "./trialIdentityVerification.service.js";

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const provisioningError = (code, message, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const assertAutomaticProvisioningEnabled = () => {
  const raw = String(
    process.env.TWILIO_AUTOMATIC_NUMBER_PROVISIONING_ENABLED ?? "true",
  )
    .trim()
    .toLowerCase();

  if (raw === "false") {
    throw provisioningError(
      "TWILIO_AUTOMATIC_PROVISIONING_DISABLED",
      "Automatic tracking-number provisioning is temporarily disabled.",
    );
  }
};

export const provisioningBudgetEnabled = () =>
  securityGateEnabled("TWILIO_PROVISIONING_BUDGET_ENABLED", {
    productionDefault: true,
  });

export const assertAutomaticProvisioningBudget = async () => {
  assertAutomaticProvisioningEnabled();

  if (!provisioningBudgetEnabled()) {
    return { skipped: true };
  }

  const now = new Date();
  const hourStart = new Date(now.getTime() - 60 * 60 * 1000);
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const maxPerHour = positiveInteger(
    process.env.TWILIO_AUTO_PROVISION_MAX_PER_HOUR,
    8,
  );
  const maxPerDay = positiveInteger(
    process.env.TWILIO_AUTO_PROVISION_MAX_PER_DAY,
    20,
  );

  const [hourCount, dayCount] = await Promise.all([
    Business.countDocuments({
      "trackingNumber.assignedAt": { $gte: hourStart },
    }),
    Business.countDocuments({
      "trackingNumber.assignedAt": { $gte: dayStart },
    }),
  ]);

  const exceeded =
    hourCount >= maxPerHour || dayCount >= maxPerDay;

  if (exceeded) {
    void SecurityAlertService.dispatch(
      "twilio_number_provisioning_budget_reached",
      {
        hourCount,
        dayCount,
        maxPerHour,
        maxPerDay,
      },
      "error",
    ).catch(() => {});

    throw provisioningError(
      "TWILIO_PROVISIONING_BUDGET_REACHED",
      "Automatic tracking-number provisioning is temporarily at capacity.",
    );
  }

  return { hourCount, dayCount, maxPerHour, maxPerDay };
};

export default {
  assertAutomaticProvisioningEnabled,
  provisioningBudgetEnabled,
  assertAutomaticProvisioningBudget,
};
