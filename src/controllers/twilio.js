import {
  handleInboundSmsWebhook,
  handleManualSmsRequest,
  handleSmsRecoveryVoiceWebhook,
  handleTwilioStatusWebhook,
} from "../services/twilioSmsWebhook.service.js";

/*
 * The public Twilio controller is intentionally thin.
 *
 * Inbound SMS, voice-recovery, status-callback and manual-SMS business logic
 * lives in twilioSmsWebhook.service.js, where idempotency, tenant resolution,
 * communication limits and provider safety are tested. Keeping old private
 * helper implementations in this controller inflated critical-file coverage
 * risk and created two competing sources of truth.
 */
class TwilioController {
  static async voiceWebhook(req, res) {
    return handleSmsRecoveryVoiceWebhook(req, res);
  }

  static async statusWebhook(req, res) {
    return handleTwilioStatusWebhook(req, res);
  }

  static async handleInboundSms(req, res) {
    return handleInboundSmsWebhook(req, res);
  }

  static async sendManualSms(req, res) {
    return handleManualSmsRequest(req, res);
  }
}

export default TwilioController;
