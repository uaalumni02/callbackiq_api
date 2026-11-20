import { VOICE_RECORDING_POLICY, VOICE_RECORDING_SUPPORTED, getVoiceHttpBaseUrl, getVoiceWebSocketUrl, isConversationRelayConfigured, isPhase9ForcedRelayFailureEnabled, routingPolicyUsesStaff, routingPolicyUsesVoiceAi } from "../../voice/voiceRouting.service.js";
import { getOwnedBusiness } from "../../services/businessScope.service.js";
import { normalizePhoneToE164, phoneNumbersEqual } from "../../voice/voicePhone.service.js";
import { serialize } from "./helpers.js";

export default class VoiceSettingsReadinessController {
static async readiness(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const settings = serialize(business);
      const usesVoiceAi = routingPolicyUsesVoiceAi(settings.routingPolicy);
      const usesStaff = routingPolicyUsesStaff(settings.routingPolicy);
      const relayConfigured = isConversationRelayConfigured();
      const trackingPhone = normalizePhoneToE164(business?.phone);
      const staffPhone = normalizePhoneToE164(settings.transferPhone);
      const livePhone = normalizePhoneToE164(settings.liveTransferPhone);
      const staffDistinct = !staffPhone || !phoneNumbersEqual(staffPhone, trackingPhone);
      const liveDistinct =
        !livePhone ||
        (!phoneNumbersEqual(livePhone, trackingPhone) &&
          !phoneNumbersEqual(livePhone, staffPhone));

      const checks = {
        voiceFeatureEnabled: settings.voiceAiEnabled,
        routingPolicyConfigured: settings.routingPolicyVersion >= 1,
        secureWebSocketConfigured:
          !usesVoiceAi || /^wss:\/\//i.test(getVoiceWebSocketUrl()),
        httpCallbackConfigured:
          !settings.voiceAiEnabled || /^https:\/\//i.test(getVoiceHttpBaseUrl()),
        twilioSignatureValidationConfigured:
          !usesVoiceAi || Boolean(String(process.env.TWILIO_AUTH_TOKEN || "").trim()),
        transferPhoneConfigured: !usesStaff || Boolean(staffPhone),
        transferPhoneIsDedicated: staffDistinct,
        liveTransferPhoneConfigured:
          !settings.liveTransferEnabled || Boolean(livePhone),
        liveTransferPhoneIsDedicated: liveDistinct,
        aiBookingEnabled: settings.aiBookingEnabled,
        callbackCaptureAvailable: Boolean(business?._id && business?.phone),
        recordingSupported: VOICE_RECORDING_SUPPORTED,
        recordingDisabled: settings.recordingEnabled === false,
        recordingPolicy: VOICE_RECORDING_POLICY,
        conversationRelayConfigured: !usesVoiceAi || relayConfigured,
        forcedFailureTestModeDisabled: !isPhase9ForcedRelayFailureEnabled(),
        maxCallDurationSafe:
          settings.maxCallDurationSeconds >= 60 &&
          settings.maxCallDurationSeconds <= 600,
        overflowWindowSafe:
          settings.overflowRingSeconds >= 15 &&
          settings.overflowRingSeconds <= 25,
      };
      const required = [
        "voiceFeatureEnabled",
        "routingPolicyConfigured",
        "httpCallbackConfigured",
        "transferPhoneConfigured",
        "transferPhoneIsDedicated",
        "liveTransferPhoneConfigured",
        "liveTransferPhoneIsDedicated",
        "recordingDisabled",
        "forcedFailureTestModeDisabled",
        "maxCallDurationSafe",
        "overflowWindowSafe",
        ...(usesVoiceAi
          ? [
              "secureWebSocketConfigured",
              "twilioSignatureValidationConfigured",
              "conversationRelayConfigured",
            ]
          : []),
      ];
      const voiceAnsweringReady = required.every((key) => Boolean(checks[key]));
      const blockers = required.filter((key) => !checks[key]);
      const warnings = [];
      if (!settings.aiBookingEnabled) {
        warnings.push(
          "Automatic booking is disabled. Voice AI will capture a verified callback instead of promising an appointment.",
        );
      }
      if (!settings.liveTransferEnabled) {
        warnings.push(
          "Post-AI live transfer is off. Explicit human requests will become priority callbacks.",
        );
      }
      if (!settings.configuredWelcomeGreeting) {
        warnings.push(
          `The dynamic greeting will identify ${business?.businessName || "the business"}.`,
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          ready: voiceAnsweringReady,
          blockers,
          warnings,
          checks,
          capabilities: {
            voiceAnsweringReady,
            callbackCaptureReady: Boolean(checks.callbackCaptureAvailable),
            callbackCaptureEnabled: Boolean(checks.callbackCaptureAvailable),
            automaticBookingEnabled: settings.aiBookingEnabled,
            staffRoutingReady: !usesStaff || Boolean(staffPhone && staffDistinct),
            liveTransferReady:
              settings.liveTransferEnabled && Boolean(livePhone && liveDistinct),
            liveTransferEnabled:
              settings.liveTransferEnabled && Boolean(livePhone && liveDistinct),
          },
          recoveryPolicy: {
            bookingUnavailable: "capture_callback",
            lowConfidence: "capture_callback",
            unsupportedRequest: "capture_callback",
            explicitHumanRequest:
              settings.liveTransferEnabled && livePhone && liveDistinct
                ? "live_transfer_during_open_hours"
                : "capture_callback",
            liveTransferWindow: "configured_business_hours_only",
            transferAcceptanceMode: "press_1_screened",
            failedLiveTransfer: "callback_sms_and_alert",
          },
          requirements: { usesVoiceAi, usesStaff },
          settings,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
}
