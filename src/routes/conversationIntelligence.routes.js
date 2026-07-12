import express from "express";

import ConversationIntelligenceController from "../controllers/conversationIntelligence.js";
import checkAuth from "../middleware/check-auth.js";
import checkActiveBusiness from "../middleware/check-active-business.js";
import checkSubscription from "../middleware/check-subscription.js";

const router = express.Router();

/*
|--------------------------------------------------------------------------
| Authentication & Access
|--------------------------------------------------------------------------
*/

router.use(checkAuth);
router.use(checkActiveBusiness);
router.use(checkSubscription);

/*
|--------------------------------------------------------------------------
| Static Routes
|--------------------------------------------------------------------------
*/

router.get(
  "/",
  ConversationIntelligenceController.getMyConversationIntelligence,
);

router.get("/dashboard", ConversationIntelligenceController.getDashboard);

router.get(
  "/opportunities",
  ConversationIntelligenceController.getOpportunities,
);

/*
|--------------------------------------------------------------------------
| Conversation Analysis
|--------------------------------------------------------------------------
*/

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
