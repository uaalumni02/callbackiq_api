import {
  handleSmsRecoveryVoiceWebhook,
  handleTwilioStatusWebhook,
  handleInboundSmsWebhook,
  handleManualSmsRequest,
} from "../services/twilioSmsWebhook.service.js";

/*
 * TwilioController is intentionally a thin Express adapter.
 *
 * Persistence, compliance, idempotency, conversation orchestration,
 * provider behavior, Voice/SMS workflows, and business logic live in
 * twilioSmsWebhook.service.js.
 *
 * Keeping this controller thin prevents duplicate implementations and
 * gives Twilio workflows one authoritative production path.
 */
class TwilioController {
  static voiceWebhook(req, res) {
    return handleSmsRecoveryVoiceWebhook(req, res);
  }

  static statusWebhook(req, res) {
    return handleTwilioStatusWebhook(req, res);
  }

  static handleInboundSms(req, res) {
    return handleInboundSmsWebhook(req, res);
  }

  static sendManualSms(req, res) {
    return handleManualSmsRequest(req, res);
  }
}

export default TwilioController;
