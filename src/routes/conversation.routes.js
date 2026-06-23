import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import ConversationController from "../controllers/conversation.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, checkSubscription, ConversationController.createConversation)
  .get(checkAuth, checkSubscription, ConversationController.getMyConversations);

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
    checkSubscription,
    ConversationController.deleteConversation,
  );

export default router;
