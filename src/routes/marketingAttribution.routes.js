// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import express from "express";
import MarketingAttributionController from "../controllers/marketingAttribution.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";

const router = express.Router();
router.use(checkAuth, checkSubscription);

router.get("/", MarketingAttributionController.list);
router.post("/", MarketingAttributionController.create);
router.patch("/:id", MarketingAttributionController.update);
router.post("/:id/tracking-number", MarketingAttributionController.provisionNumber);

export default router;
