import { assertNoDialLoops, serialize, validateUpdate, validationError, voiceSettingsObject } from "./helpers.js";
import { getOwnedBusiness } from "../../services/businessScope.service.js";
import { getPresetRoutingPolicy, inferAnswerMode } from "../../voice/voiceRouting.service.js";
import { normalizePhoneToE164 } from "../../voice/voicePhone.service.js";
import { publishVoiceSettingsVersion } from "../../services/voiceSettingsVersion.service.js";
import { validateVoiceSettingsDraft } from "../../services/voiceSettingsContract.service.js";

export default class VoiceSettingsCommandsController {
static async update(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const current = serialize(business);
      const update = validateUpdate(req.body || {}, current);
      const voiceSettings = voiceSettingsObject(business);
      const previousVoiceSettingsSnapshot = {
        features: {
          voiceAiEnabled: Boolean(business?.features?.voiceAiEnabled),
          aiBookingEnabled: Boolean(business?.features?.aiBookingEnabled),
        },
        voiceSettings: business?.voiceSettings?.toObject?.() || { ...(business?.voiceSettings || {}) },
      };

      let voiceAiEnabled = Object.hasOwn(update, "voiceAiEnabled")
        ? update.voiceAiEnabled
        : current.voiceAiEnabled;
      let routingPolicy = { ...current.routingPolicy };
      if (
        Object.hasOwn(update, "answerMode") &&
        update.answerMode !== "custom" &&
        !Object.hasOwn(update, "routingPolicy")
      ) {
        routingPolicy = getPresetRoutingPolicy(update.answerMode);
        voiceAiEnabled = update.answerMode !== "disabled";
      }
      if (Object.hasOwn(update, "routingPolicy")) {
        routingPolicy = update.routingPolicy;
      }

      const answerMode = inferAnswerMode({ voiceAiEnabled, routingPolicy });
      const merged = {
        ...voiceSettings,
        answerMode,
        routingPolicyVersion: 1,
        routingPolicy,
        recordingEnabled: false,
      };
      for (const key of [
        "overflowRingSeconds",
        "maxCallDurationSeconds",
        "transferPhone",
        "liveTransferPhone",
        "welcomeGreeting",
        "voiceName",
        "liveTransferEnabled",
        "maxConcurrentCalls",
        "dailyVoiceMinutes",
        "monthlyVoiceMinutes",
        "voiceHardCapEnabled",
        "voiceOverageEnabled",
        "callerVelocityLimitPerHour",
        "agentConfirmationRequired",
        "answeringMachineDetectionEnabled",
      ]) {
        if (Object.hasOwn(update, key)) merged[key] = update[key];
      }

      assertNoDialLoops({ business, settings: merged });
      if (merged.liveTransferEnabled && !normalizePhoneToE164(merged.liveTransferPhone)) {
        throw validationError(
          "Configure a dedicated live-transfer phone before enabling live transfer.",
        );
      }

      business.set("features.voiceAiEnabled", voiceAiEnabled);
      if (Object.hasOwn(update, "aiBookingEnabled")) {
        business.set("features.aiBookingEnabled", update.aiBookingEnabled);
      }
      const contractValidation = validateVoiceSettingsDraft(
        { ...merged, voiceAiEnabled },
        { currentVoiceName: current.voiceName },
      );
      if (!contractValidation.valid) {
        throw validationError(
          contractValidation.errors.map((item) => item.message).join(" "),
          400,
          "VOICE_SETTINGS_CONTRACT_INVALID",
        );
      }
      business.set("voiceSettings", merged);
      const published = await publishVoiceSettingsVersion({
        business,
        previousSnapshot: previousVoiceSettingsSnapshot,
        publishedBy: req.user?.userId || req.user?._id || null,
        reason: req.body?.publishReason || "Voice settings published from dashboard.",
      });
      return res.status(200).json({
        success: true,
        data: serialize(business),
        publication: { version: published.version, warnings: contractValidation.warnings },
      });
    } catch (error) {
      return next(error);
    }
  }
}
