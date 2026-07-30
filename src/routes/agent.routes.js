import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import { agentReplyRateLimit } from "../middleware/twilio-webhook-rate-limit.js";
import AgentController from "../controllers/agent.js";

const router = express.Router();

router.post(
  "/reply",
  checkAuth,
  checkSubscription,
  agentReplyRateLimit,
  AgentController.replyToConversation,
);

export default router;
