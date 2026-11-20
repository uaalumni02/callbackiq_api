import "../../models/business.js";
import "../../voice/voicePhone.service.js";
import VoiceSession from "../../models/voiceSession.js";
import VoiceSessionService from "../../voice/voiceSession.service.js";
import { isTerminal, sendXml } from "./helpers.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";
import { staffScreenDecisionTwiml, staffScreenPromptTwiml } from "../../voice/voiceRouting.service.js";

export default class VoiceWebhookStaffScreenController {
static async staffScreen(req, res) {
    try {
      const purpose = ["initialStaff", "liveTransfer", "failureStaff"].includes(
        req.query?.purpose,
      )
        ? req.query?.purpose
        : "initialStaff";
      const callSid = req.query?.callSid || req.body?.ParentCallSid || "";
      if (callSid) {
        const session = await VoiceSession.findOne({ providerCallSid: callSid });
        if (session && !isTerminal(session)) {
          await VoiceSessionService.touchActivity(session._id, {
            [`${purpose}ScreenPromptedAt`]: new Date().toISOString(),
          });
        }
      }
      return sendXml(
        res,
        staffScreenPromptTwiml({
          decisionPath: `/api/twilio/voice-staff-screen-decision?purpose=${encodeURIComponent(
            purpose,
          )}`,
          providerCallSid: callSid,
        }),
      );
    } catch (error) {
      logOperationalError("voice.staff_screen_failed", error, {});
      return sendXml(res, staffScreenDecisionTwiml({ accepted: false }));
    }
  }

static async staffScreenDecision(req, res) {
    try {
      const accepted = String(req.body?.Digits || "") === "1";
      const purpose = ["initialStaff", "liveTransfer", "failureStaff"].includes(
        req.query?.purpose,
      )
        ? req.query?.purpose
        : "initialStaff";
      const callSid = req.query?.callSid || req.body?.ParentCallSid || "";
      if (callSid) {
        const session = await VoiceSession.findOne({ providerCallSid: callSid });
        if (session && !isTerminal(session)) {
          await VoiceSessionService.touchActivity(session._id, {
            [`${purpose}ScreenAcceptedAt`]: accepted
              ? new Date().toISOString()
              : null,
            [`${purpose}ScreenRejectedAt`]: accepted
              ? null
              : new Date().toISOString(),
          });
        }
      }
      return sendXml(res, staffScreenDecisionTwiml({ accepted }));
    } catch (error) {
      logOperationalError("voice.staff_screen_decision_failed", error, {});
      return sendXml(res, staffScreenDecisionTwiml({ accepted: false }));
    }
  }
}
