import express from "express";

import checkAuth from "../middleware/check-auth.js";
import ConversationController from "../controllers/conversation.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, ConversationController.createConversation)
  .get(checkAuth, ConversationController.getMyConversations);

router
  .route("/:id")
  .get(checkAuth, ConversationController.getConversationById)
  .patch(checkAuth, ConversationController.updateConversation)
  .delete(checkAuth, ConversationController.deleteConversation);

export default router;
