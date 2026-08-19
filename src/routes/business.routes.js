import express from "express";

import checkAuth from "../middleware/check-auth.js";
import BusinessSetupController from "../controllers/businessSetup.js";
import BusinessController from "../controllers/business.js";
import VerificationController from "../controllers/verification.js";
import {
  phoneVerificationCheckRateLimit,
  phoneVerificationStartRateLimit,
} from "../middleware/verification-rate-limits.js";

const router = express.Router();

router.route("/").post(checkAuth, BusinessController.createBusiness);

router
  .route("/mine")
  .get(checkAuth, BusinessController.getMyBusiness)
  .patch(checkAuth, BusinessController.updateMyBusiness)
  .delete(checkAuth, BusinessController.deleteMyBusiness);

router.get("/mine/readiness", checkAuth, BusinessSetupController.readiness);
router.get(
  "/mine/tracking-number",
  checkAuth,
  BusinessSetupController.trackingNumber,
);
router.post(
  "/mine/tracking-number/provision",
  checkAuth,
  BusinessSetupController.provision,
);
router.post(
  "/mine/tracking-number/verify",
  checkAuth,
  BusinessSetupController.verify,
);
router.post(
  "/mine/tracking-number/activate",
  checkAuth,
  BusinessSetupController.activate,
);
router.patch(
  "/mine/setup-progress",
  checkAuth,
  BusinessSetupController.updateProgress,
);

router.post(
  "/mine/phone-verification/start",
  checkAuth,
  phoneVerificationStartRateLimit,
  VerificationController.startPhone,
);
router.post(
  "/mine/phone-verification/check",
  checkAuth,
  phoneVerificationCheckRateLimit,
  VerificationController.checkPhone,
);

router.route("/:id").get(checkAuth, BusinessController.getBusinessById);

export default router;
