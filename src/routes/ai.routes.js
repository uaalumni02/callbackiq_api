import express from "express";

import checkAuth from "../middleware/check-auth.js";
import AiController from "../controllers/ai.js";

const router = express.Router();

router.post("/qualify-lead", checkAuth, AiController.qualifyLead);

export default router;
