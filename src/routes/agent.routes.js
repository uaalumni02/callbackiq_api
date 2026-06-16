import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import AgentController from "../controllers/agent.js";

const router = express.Router();

router.post(
  "/reply",
  checkAuth,
  checkSubscription,
  AgentController.replyToConversation,
);

export default router;
