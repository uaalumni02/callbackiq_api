import express from "express";
import {
  getUsage,
  getMetrics,
  reviewEmergency,
  getSecurityStatus,
  receiveUsageTrigger,
} from "../controllers/voiceOperations.controller.js";
import checkAuth from "../middleware/check-auth.js";
import validateTwilioSignature from "../middleware/validate-twilio-signature.js";

const router = express.Router();

router.get("/usage", checkAuth, getUsage);
router.get("/metrics", checkAuth, getMetrics);
router.post("/metrics/emergency-review", checkAuth, reviewEmergency);
router.get("/security-status", checkAuth, getSecurityStatus);
router.post("/twilio-usage-trigger", validateTwilioSignature, receiveUsageTrigger);

export default router;
