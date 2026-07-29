import express from "express";

import VoiceSettingsController from "../controllers/voiceSettings.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.use(checkAuth);
router.get("/", VoiceSettingsController.get);
router.put("/", VoiceSettingsController.update);
router.get("/readiness", VoiceSettingsController.readiness);

export default router;
