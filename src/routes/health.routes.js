import express from "express";

import HealthController from "../controllers/health.js";

const router = express.Router();

router.get("/", HealthController.live);
router.get("/live", HealthController.live);
router.get("/ready", HealthController.ready);

export default router;
