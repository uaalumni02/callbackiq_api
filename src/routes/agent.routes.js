import express from "express";

import checkAuth from "../middleware/check-auth.js";
import AgentController from "../controllers/agent.js";

const router = express.Router();

router.post("/reply", checkAuth, AgentController.replyToConversation);

export default router;
