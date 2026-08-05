import MessageMediaController from "../controllers/messageMedia.js";
import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import MessageController from "../controllers/message.js";

const router = express.Router();

router.post("/", checkAuth, checkSubscription, MessageController.createMessage);

router.get(
  "/conversation/:conversationId",
  checkAuth,
  checkSubscription,
  MessageController.getMessagesByConversation,
);

router.get(
  "/:messageId/media/:mediaIndex",
  checkAuth,
  checkSubscription,
  MessageMediaController.getMedia,
);

router.get(
  "/:id",
  checkAuth,
  checkSubscription,
  MessageController.getMessageById,
);

router.delete(
  "/:id",
  checkAuth,
  checkSubscription,
  MessageController.deleteMessage,
);

export default router;
