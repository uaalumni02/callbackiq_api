import VoiceUsageService from "../services/voiceUsage.service.js";
import TwilioSignatureRotationService from "../services/twilioSignatureRotation.service.js";
import VoiceMetricsService from "../voice/voiceMetrics.service.js";

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
export const getMetrics = async (req, res, next) => {
  try {
    const businessId = businessIdFrom(req);
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    const metrics = await VoiceMetricsService.getVoicePilotMetrics({ businessId, from, to });
    res.json({ success: true, data: metrics });
  } catch (error) {
    next(error);
  }
};

export const reviewEmergency = async (req, res, next) => {
  try {
    const data = await VoiceMetricsService.reviewEmergencyClassification({
      businessId: businessIdFrom(req),
      sessionId: req.body?.sessionId,
      classification: req.body?.classification,
      notes: req.body?.notes,
    });
    res.json({ success: true, data });
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

export default { getUsage, getMetrics, reviewEmergency, getSecurityStatus, receiveUsageTrigger };
