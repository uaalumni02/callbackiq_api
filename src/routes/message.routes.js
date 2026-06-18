import express from "express";

import checkAuth from "../middleware/check-auth.js";
import MessageController from "../controllers/message.js";

const router = express.Router();

router.post("/", checkAuth, MessageController.createMessage);

router.get(
  "/conversation/:conversationId",
  checkAuth,
  MessageController.getMessagesByConversation,
);

router.get("/:id", checkAuth, MessageController.getMessageById);

router.delete("/:id", checkAuth, MessageController.deleteMessage);

export default router;
