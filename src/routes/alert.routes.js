import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import AlertController from "../controllers/alert.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, checkSubscription, AlertController.createAlert)
  .get(checkAuth, checkSubscription, AlertController.getMyAlerts);

router.patch(
  "/read-all",
  checkAuth,
  checkSubscription,
  AlertController.markAllAlertsRead,
);

router.patch(
  "/:id/read",
  checkAuth,
  checkSubscription,
  AlertController.markAlertRead,
);

router
  .route("/:id")
  .get(checkAuth, checkSubscription, AlertController.getAlertById)
  .patch(checkAuth, checkSubscription, AlertController.updateAlert)
  .delete(checkAuth, checkSubscription, AlertController.deleteAlert);

export default router;
