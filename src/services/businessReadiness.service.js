import AvailabilityRule from "../models/availabilityRule.js";
import Business from "../models/business.js";
import BusinessOperationsSettings from "../models/businessOperationsSettings.js";
import IntegrationConnection from "../models/integrationConnection.js";
import SchedulingPolicy from "../models/schedulingPolicy.js";
import ServiceArea from "../models/serviceArea.js";
import ServiceOffering from "../models/serviceOffering.js";
import Subscription from "../models/subscription.js";

const CONNECTED_PROVIDER = {
  google: "google_calendar",
  jobber: "jobber",
  housecall_pro: "housecall_pro",
  servicetitan: "servicetitan",
};

const hasServiceArea = (serviceArea) =>
  serviceArea?.type === "unrestricted" ? true : serviceArea?.type === "zip_codes"
    ? Boolean(serviceArea?.zipCodes?.length)
    : Boolean(serviceArea?.centerPostalCode && Number(serviceArea?.radiusMiles) > 0);

const hasAvailability = (rules = []) =>
  rules.some(
    (rule) =>
      rule.enabled &&
      Array.isArray(rule.windows) &&
      rule.windows.some(
        (window) =>
          window?.allDay ||
          (String(window?.startTime || "").trim() &&
            String(window?.endTime || "").trim()),
      ),
  );

const subscriptionReady = (subscription) =>
  Boolean(
    subscription?.isActive &&
      ["active", "trialing"].includes(String(subscription?.status || "")) &&
      String(subscription?.stripeSubscriptionId || "").trim(),
  );

const trackingStatus = (business) =>
  String(business?.trackingNumber?.status || "unassigned");

const addMissing = (list, condition, code, message, action) => {
  if (!condition) list.push({ code, message, action });
};

const providerName = (provider) => {
  if (provider === "google") return "Google Calendar";
  if (provider === "housecall_pro") return "Housecall Pro";
  if (provider === "servicetitan") return "ServiceTitan";
  if (provider === "jobber") return "Jobber";
  return "Internal calendar";
};

export const buildBusinessReadiness = async (
  businessOrId,
  { persist = true } = {},
) => {
  const business = businessOrId?._id
    ? businessOrId
    : await Business.findById(businessOrId);

  if (!business) {
    const error = new Error("Business not found");
    error.code = "BUSINESS_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  const businessId = business._id;
  const [
    subscription,
    services,
    rules,
    schedulingPolicy,
    serviceArea,
    operationsSettings,
    providerConnections,
  ] = await Promise.all([
    Subscription.findOne({ business: businessId }).lean(),
    ServiceOffering.find({ business: businessId, active: true }).lean(),
    AvailabilityRule.find({ business: businessId }).lean(),
    SchedulingPolicy.findOne({ business: businessId }).lean(),
    ServiceArea.findOne({ business: businessId }).lean(),
    BusinessOperationsSettings.findOne({ business: businessId }).lean(),
    IntegrationConnection.find({ business: businessId }).lean(),
  ]);

  const provider = business.features?.calendarProvider || "internal";
  const expectedProvider = CONNECTED_PROVIDER[provider];
  const providerConnection = expectedProvider
    ? providerConnections.find((item) => item.provider === expectedProvider)
    : null;
  const calendarReady =
    provider === "internal" || (["google_calendar", "google", "jobber"].includes(provider) && providerConnection?.status === "connected");

  const checks = {
    accountRegistered: true,
    subscriptionActive: subscriptionReady(subscription),
    forwardingPhoneConfigured: Boolean(business.forwardingPhone),
    trackingNumberAssigned: ["assigned", "verified", "active"].includes(
      trackingStatus(business),
    ),
    trackingNumberVerified: ["verified", "active"].includes(
      trackingStatus(business),
    ),
    trackingNumberActive: trackingStatus(business) === "active",
    // CALLBACKIQ_A2P_ORCHESTRATION_READINESS
    smsMessagingReady: business.messagingCompliance?.smsReady === true,
    servicesConfigured: services.some(
      (service) => Number(service.durationMinutes) > 0,
    ),
    serviceAreaConfigured: hasServiceArea(serviceArea),
    availabilityConfigured: hasAvailability(rules),
    bookingRulesConfigured: Boolean(schedulingPolicy),
    aiBookingPermissionConfigured: Boolean(
      operationsSettings?.aiPermissions?.canBookEligibleServices,
    ),
    calendarConfigured: calendarReady,
  };

  const bookingConfigurationReady =
    checks.servicesConfigured &&
    checks.serviceAreaConfigured &&
    checks.availabilityConfigured &&
    checks.bookingRulesConfigured &&
    checks.aiBookingPermissionConfigured &&
    checks.calendarConfigured;

  const states = {
    smsRecoveryReady:
      checks.subscriptionActive &&
      checks.trackingNumberActive &&
      checks.smsMessagingReady &&
      business.features?.missedCallSmsEnabled !== false && business.customerMessaging?.automaticTextsEnabled !== false,
    calendarReady: checks.calendarConfigured,
    bookingConfigurationReady,
    bookingReady:
      bookingConfigurationReady && business.features?.aiBookingEnabled === true,
    voiceAiReady:
      checks.subscriptionActive &&
      checks.trackingNumberActive &&
      checks.forwardingPhoneConfigured &&
      business.features?.voiceAiEnabled === true &&
      business.voiceSettings?.answerMode !== "disabled",
  };

  const missingRequirements = {
    smsRecovery: [],
    calendar: [],
    booking: [],
    voiceAi: [],
  };

  addMissing(
    missingRequirements.smsRecovery,
    checks.subscriptionActive,
    "subscription_required",
    "Complete CallBackIQ subscription checkout before a CallBackIQ number can be assigned or used.",
    "/billing",
  );
  addMissing(
    missingRequirements.smsRecovery,
    checks.trackingNumberActive,
    "tracking_number_not_active",
    "Your CallBackIQ number must be assigned, verified, and active.",
    "/setup",
  );
  addMissing(
    missingRequirements.smsRecovery,
    checks.smsMessagingReady,
    "messaging_registration_pending",
    "Text messaging carrier verification is still processing. Calls are active; SMS will turn on automatically after registration completes.",
    "/setup",
  );
  addMissing(
    missingRequirements.smsRecovery,
    business.features?.missedCallSmsEnabled !== false && business.customerMessaging?.automaticTextsEnabled !== false,
    "sms_recovery_disabled",
    "Turn on missed-call SMS recovery.",
    "/settings",
  );

  addMissing(
    missingRequirements.calendar,
    checks.calendarConfigured,
    "calendar_not_connected",
    provider === "google"
      ? "Booking is off because Google Calendar isn't connected."
      : `${providerName(provider)} is not connected.`,
    "/integrations",
  );

  addMissing(
    missingRequirements.booking,
    checks.servicesConfigured,
    "services_required",
    "Add at least one active service with an appointment duration.",
    "/settings",
  );
  addMissing(
    missingRequirements.booking,
    checks.serviceAreaConfigured,
    "service_area_required",
    "Configure the ZIP codes or radius your business serves.",
    "/settings",
  );
  addMissing(
    missingRequirements.booking,
    checks.availabilityConfigured,
    "availability_required",
    "Configure at least one bookable hours/availability window.",
    "/settings",
  );
  addMissing(
    missingRequirements.booking,
    checks.bookingRulesConfigured,
    "booking_rules_required",
    "Save your booking rules before enabling automatic booking.",
    "/settings",
  );
  addMissing(
    missingRequirements.booking,
    checks.aiBookingPermissionConfigured,
    "ai_booking_permission_required",
    "Allow the AI to book eligible services in Business Configuration.",
    "/settings",
  );
  addMissing(
    missingRequirements.booking,
    checks.calendarConfigured,
    "calendar_not_connected",
    provider === "google"
      ? "Booking is off because Google Calendar isn't connected."
      : `Connect ${providerName(provider)} before enabling automatic booking.`,
    "/integrations",
  );

  if (
    bookingConfigurationReady &&
    business.features?.aiBookingEnabled !== true
  ) {
    missingRequirements.booking.push({
      code: "automatic_booking_disabled",
      message: "Automatic booking is configured but still turned off.",
      action: "/setup",
    });
  }

  addMissing(
    missingRequirements.voiceAi,
    checks.subscriptionActive,
    "subscription_required",
    "Complete CallBackIQ subscription checkout before Voice AI can run.",
    "/billing",
  );
  addMissing(
    missingRequirements.voiceAi,
    checks.trackingNumberActive,
    "tracking_number_not_active",
    "Activate your CallBackIQ number before enabling Voice AI.",
    "/setup",
  );
  addMissing(
    missingRequirements.voiceAi,
    checks.forwardingPhoneConfigured,
    "forwarding_phone_required",
    "Add the existing business phone used for call routing.",
    "/settings",
  );
  addMissing(
    missingRequirements.voiceAi,
    business.features?.voiceAiEnabled === true,
    "voice_ai_disabled",
    "Voice AI is currently turned off.",
    "/settings",
  );
  addMissing(
    missingRequirements.voiceAi,
    business.voiceSettings?.answerMode !== "disabled",
    "voice_answer_mode_disabled",
    "Choose when Voice AI should answer calls.",
    "/settings",
  );

  const configuredCore = [
    checks.subscriptionActive,
    checks.forwardingPhoneConfigured,
    checks.trackingNumberActive,
    checks.servicesConfigured,
    checks.serviceAreaConfigured,
    checks.availabilityConfigured,
    checks.bookingRulesConfigured,
    checks.calendarConfigured,
  ];
  const completionPercentage = Math.round(
    (configuredCore.filter(Boolean).length / configuredCore.length) * 100,
  );

  const existingProgress =
    business.setupProgress?.toObject?.() || business.setupProgress || {};
  const setupProgress = {
    ...existingProgress,
    accountRegistered: true,
    subscriptionActivated: checks.subscriptionActive,
    forwardingPhoneConfigured: checks.forwardingPhoneConfigured,
    trackingNumberAssigned: checks.trackingNumberAssigned,
    trackingNumberVerified: checks.trackingNumberVerified,
    trackingNumberActive: checks.trackingNumberActive,
    smsMessagingReady: checks.smsMessagingReady,
    servicesConfigured: checks.servicesConfigured,
    serviceAreaConfigured: checks.serviceAreaConfigured,
    availabilityConfigured: checks.availabilityConfigured,
    bookingRulesConfigured: checks.bookingRulesConfigured,
    aiBookingPermissionConfigured: checks.aiBookingPermissionConfigured,
    calendarConfigured: checks.calendarConfigured,
    updatedAt: new Date(),
  };

  const liveTestComplete = Boolean(
    setupProgress.smsRecoveryTested && setupProgress.inboxTested,
  );
  const coreSetupComplete = Boolean(
    checks.subscriptionActive &&
      checks.forwardingPhoneConfigured &&
      checks.trackingNumberActive,
  );
  setupProgress.completedAt =
    coreSetupComplete && liveTestComplete
      ? setupProgress.completedAt || new Date()
      : null;

  if (persist) {
    await Business.updateOne(
      { _id: businessId },
      { $set: { setupProgress } },
    );
  }

  return {
    businessId,
    trackingNumber: {
      phone: business.phone || "",
      status: trackingStatus(business),
      provider: business.trackingNumber?.provider || "twilio",
      assignedAt: business.trackingNumber?.assignedAt || null,
      verifiedAt: business.trackingNumber?.verifiedAt || null,
      activatedAt: business.trackingNumber?.activatedAt || null,
      lastError: business.trackingNumber?.lastError || "",
    },
    forwardingPhone: business.forwardingPhone || "",
    messagingCompliance: {
      a2pStatus: business.messagingCompliance?.a2pStatus || "unconfigured",
      campaignStatus: business.messagingCompliance?.campaignStatus || "",
      smsReady: checks.smsMessagingReady,
      senderAttached: Boolean(business.messagingCompliance?.senderAttached),
    },
    calendarProvider: provider,
    checks,
    states,
    setupProgress,
    completionPercentage,
    missingRequirements,
  };
};

export const assertBookingCanBeEnabled = async (business) => {
  const readiness = await buildBusinessReadiness(business, { persist: true });
  if (!readiness.states.bookingConfigurationReady) {
    const error = new Error(
      readiness.missingRequirements.booking[0]?.message ||
        "Automatic booking is not ready.",
    );
    error.code = "BOOKING_NOT_READY";
    error.statusCode = 400;
    error.readiness = readiness;
    throw error;
  }
  return readiness;
};

export default {
  buildBusinessReadiness,
  assertBookingCanBeEnabled,
};
