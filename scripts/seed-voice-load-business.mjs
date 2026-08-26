#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";
import Business from "../src/models/business.js";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const flag = (name) => env(name).toLowerCase() === "true";
const number = (name, fallback) => {
  const parsed = Number.parseInt(env(name, fallback), 10);
  return Number.isFinite(parsed) ? parsed : Number(fallback);
};

const uri = env("MONGODB_URI", env("MONGO_URL", env("MONGO_URI")));
if (!uri) throw new Error("MONGODB_URI is required.");
if (!flag("VOICE_LOAD_ALLOW_DB_WRITES")) {
  throw new Error(
    "Refusing to seed data. Set VOICE_LOAD_ALLOW_DB_WRITES=true only for a dedicated load-test database.",
  );
}

await mongoose.connect(uri);
try {
  const dbName = mongoose.connection.name || "";
  const safeName = /(load|test|perf|benchmark)/i.test(dbName);
  if (!safeName && !flag("VOICE_LOAD_ALLOW_NONTEST_DB")) {
    throw new Error(
      `Refusing to modify database \"${dbName}\". Use a database name containing load/test/perf/benchmark or explicitly set VOICE_LOAD_ALLOW_NONTEST_DB=true.`,
    );
  }

  const businessName = env("VOICE_LOAD_BUSINESS_NAME", "CallBackIQ Voice Load Test");
  const phone = env("VOICE_LOAD_TO", "+12025550123");
  const maxConcurrentCalls = Math.min(100, Math.max(1, number("VOICE_LOAD_MAX_CONCURRENT", 25)));

  let business = await Business.findOne({
    $or: [{ businessName }, { phone }],
  });

  if (!business) {
    business = new Business({ owner: new mongoose.Types.ObjectId() });
  }

  business.set({
    businessName,
    businessType: "plumbing",
    phone,
    trackingNumber: {
      provider: "twilio",
      status: "active",
      assignedAt: new Date(),
      verifiedAt: new Date(),
      activatedAt: new Date(),
      updatedAt: new Date(),
    },
    timezone: "America/New_York",
    isActive: true,
    estimatedJobValue: 450,
    features: {
      // Critical load-test safety: any fallback path is suppressed before
      // Twilio SMS delivery is attempted.
      missedCallSmsEnabled: false,
      aiQualificationEnabled: true,
      aiBookingEnabled: false,
      automatedFollowUpEnabled: false,
      voiceAiEnabled: true,
      revenueTrackingEnabled: false,
      calendarProvider: "internal",
    },
    communicationLimits: {
      smsBusinessHourly: 100000,
      smsBusinessDaily: 100000,
      smsCustomerHourly: 10000,
      smsCustomerDaily: 10000,
      aiBusinessHourly: 100000,
      aiBusinessDaily: 100000,
      aiCustomerHourly: 10000,
      aiCustomerDaily: 10000,
      alertThresholdPercent: 90,
    },
    trialCostControls: { enabled: false },
    voiceSettings: {
      answerMode: "always",
      routingPolicyVersion: 1,
      routingPolicy: {
        openHours: "voice_ai",
        afterHours: "voice_ai",
        voiceFailure: "sms",
      },
      overflowRingSeconds: 20,
      liveTransferEnabled: false,
      transferPhone: "",
      liveTransferPhone: "",
      welcomeGreeting:
        "Thanks for calling the CallBackIQ load test business. This is the automated assistant. How can I help you today?",
      voiceName: "",
      maxConcurrentCalls,
      maxCallDurationSeconds: 120,
      dailyVoiceMinutes: 100000,
      monthlyVoiceMinutes: 1000000,
      voiceHardCapEnabled: false,
      voiceOverageEnabled: true,
      voiceUsageWarningThresholds: [70, 85, 100],
      callerVelocityLimitPerHour: 1000,
      agentConfirmationRequired: true,
      answeringMachineDetectionEnabled: false,
      recordingEnabled: false,
    },
    aiCapabilities: {
      canCollectLeadDetails: true,
      canCollectAddress: true,
      canCollectAppointmentPreference: true,
      canConfirmAppointment: false,
      canConfirmAvailability: false,
      canConfirmDispatch: false,
      canQuotePrices: false,
      canConfirmWarranty: false,
      canConfirmServiceArea: false,
    },
  });

  await business.save();

  console.log(
    JSON.stringify(
      {
        seeded: true,
        database: dbName,
        businessId: String(business._id),
        businessName: business.businessName,
        trackingNumber: business.phone,
        trackingNumberStatus: business.trackingNumber?.status,
        voiceAiEnabled: business.features?.voiceAiEnabled,
        missedCallSmsEnabled: business.features?.missedCallSmsEnabled,
        answerMode: business.voiceSettings?.answerMode,
        maxConcurrentCalls: business.voiceSettings?.maxConcurrentCalls,
        safety: "Fallback SMS is disabled for this synthetic business.",
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
