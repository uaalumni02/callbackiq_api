import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import AiController from "../controllers/ai.js";

const router = express.Router();

router.post(
  "/qualify-lead",
  checkAuth,
  checkSubscription,
  AiController.qualifyLead,
);

export default router;
