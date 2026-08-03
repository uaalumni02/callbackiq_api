import VoiceUsageService from "../services/voiceUsage.service.js";
import TwilioSignatureRotationService from "../services/twilioSignatureRotation.service.js";

const businessIdFrom = (req) =>
  req.business?._id || req.user?.business || req.user?.businessId;

export const getUsage = async (req, res, next) => {
  try {
    const businessId = businessIdFrom(req);
    const usage = await VoiceUsageService.getVoiceUsageSummary({ businessId });
    res.json({ success: true, data: usage });
  } catch (error) {
    next(error);
  }
};

export const getSecurityStatus = async (_req, res) => {
  res.json({
    success: true,
    data: {
      twilioTokenRotation:
        TwilioSignatureRotationService.getTwilioRotationState(),
    },
  });
};

export const receiveUsageTrigger = async (req, res) => {
  // Signature middleware must run before this controller.
  // Persisting the provider payload is intentionally left to the existing
  // webhook-event/audit service so this endpoint remains idempotent.
  res.status(204).send();
};

export default { getUsage, getSecurityStatus, receiveUsageTrigger };
