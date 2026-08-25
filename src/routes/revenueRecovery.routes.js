// CALLBACKIQ_SCALE_HARDENING_V1
import express from "express";
import RevenueRecoveryController from "../controllers/revenueRecovery.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";

const router = express.Router();

router.use(checkAuth, checkSubscription);
router.get("/overview", RevenueRecoveryController.overview);
router.get("/summary", RevenueRecoveryController.summary);
router.get("/trends", RevenueRecoveryController.trends);
router.get("/sources", RevenueRecoveryController.sources);
router.get("/marketing-sources", RevenueRecoveryController.marketingSources);
router.get("/lost-opportunities", RevenueRecoveryController.lost);
router.get("/funnel", RevenueRecoveryController.funnel);

export default router;
