import IntakeReviewController from "../controllers/intakeReview.js";
import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import ConversationController from "../controllers/conversation.js";

import { isCurrentAdminRequest } from "../helpers/security/current-admin.js";
const router = express.Router();

// Business owners keep the existing subscription requirement. Admins can
// perform management actions without needing a customer subscription record.
const checkSubscriptionUnlessAdmin = async (req, res, next) => {
  try {
    if (await isCurrentAdminRequest(req)) return next();
    return checkSubscription(req, res, next);
  } catch (error) {
    return next(error);
  }
};

router
  .route("/")
  .post(checkAuth, checkSubscription, ConversationController.createConversation)
  .get(checkAuth, checkSubscription, ConversationController.getMyConversations);

router.post(
  "/:id/archive",
  checkAuth,
  checkSubscriptionUnlessAdmin,
  ConversationController.archiveConversation,
);

router.post(
  "/:id/restore",
  checkAuth,
  checkSubscriptionUnlessAdmin,
  ConversationController.restoreConversation,
);

router
  .route("/:id")
  .get(checkAuth, checkSubscription, ConversationController.getConversationById)
  .patch(
    checkAuth,
    checkSubscription,
    ConversationController.updateConversation,
  )
  .delete(
    checkAuth,
    checkSubscriptionUnlessAdmin,
    ConversationController.deleteConversation,
  );

router.post("/:id/approve-intake", checkAuth, checkSubscription, IntakeReviewController.approveIntake);

export default router;
