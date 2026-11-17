import express from "express";
import {
  getUsage,
  getMetrics,
  reviewEmergency,
  getSecurityStatus,
  receiveUsageTrigger,
} from "../controllers/voiceOperations.controller.js";
import checkAuth from "../middleware/check-auth.js";
import checkActiveBusiness from '../middleware/check-active-business.js';
import checkSubscription from '../middleware/check-subscription.js';
import validateTwilioSignature from "../middleware/validate-twilio-signature.js";

const router = express.Router();

router.get("/usage", checkAuth, checkActiveBusiness, checkSubscription, getUsage);
router.get("/metrics", checkAuth, checkActiveBusiness, checkSubscription, getMetrics);
router.post("/metrics/emergency-review", checkAuth, checkActiveBusiness, checkSubscription, reviewEmergency);
router.get("/security-status", checkAuth, checkActiveBusiness, checkSubscription, getSecurityStatus);
router.post("/twilio-usage-trigger", validateTwilioSignature, receiveUsageTrigger);

export default router;
