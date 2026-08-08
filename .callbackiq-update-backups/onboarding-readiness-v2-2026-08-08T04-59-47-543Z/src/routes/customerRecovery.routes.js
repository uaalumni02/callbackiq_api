import express from "express";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import CustomerRecoveryController from "../controllers/customerRecovery.js";

const router = express.Router();
router.get(
  "/:leadId/recovery-detail",
  checkAuth,
  checkSubscription,
  CustomerRecoveryController.getRecoveryDetail,
);

export default router;
