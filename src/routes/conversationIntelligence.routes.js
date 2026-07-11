import express from "express";

import ConversationIntelligenceController from "../controllers/conversationIntelligence.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import checkActiveBusiness from "../middleware/check-active-business.js";

const router = express.Router();

router.use(checkAuth);
router.use(checkSubscription);
router.use(checkActiveBusiness);

router.get(
  "/",
  ConversationIntelligenceController.getMyConversationIntelligence,
);

router.get(
  "/opportunities",
  ConversationIntelligenceController.getOpportunities,
);

router.get("/dashboard", ConversationIntelligenceController.getDashboard);

router.post(
  "/:conversationId/analyze",
  ConversationIntelligenceController.analyzeConversation,
);

router.get(
  "/:conversationId",
  ConversationIntelligenceController.getConversationIntelligence,
);

router.patch(
  "/:conversationId/feedback",
  ConversationIntelligenceController.updateFeedback,
);

router.patch(
  "/:conversationId/action",
  ConversationIntelligenceController.updateRecommendedAction,
);

router.delete(
  "/:conversationId",
  ConversationIntelligenceController.deleteConversationIntelligence,
);

export default router;
