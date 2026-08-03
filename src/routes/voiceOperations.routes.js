import express from "express";
import {
  getUsage,
  getSecurityStatus,
  receiveUsageTrigger,
} from "../controllers/voiceOperations.controller.js";
import checkAuth from "../middleware/check-auth.js";
import validateTwilioSignature from "../middleware/validate-twilio-signature.js";

const router = express.Router();

router.get("/usage", checkAuth, getUsage);
router.get("/security-status", checkAuth, getSecurityStatus);
router.post("/twilio-usage-trigger", validateTwilioSignature, receiveUsageTrigger);

export default router;
