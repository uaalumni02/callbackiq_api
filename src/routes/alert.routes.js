import express from "express";

import checkAuth from "../middleware/check-auth.js";
import AlertController from "../controllers/alert.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, AlertController.createAlert)
  .get(checkAuth, AlertController.getMyAlerts);

router.patch("/read-all", checkAuth, AlertController.markAllAlertsRead);

router.patch("/:id/read", checkAuth, AlertController.markAlertRead);

router
  .route("/:id")
  .get(checkAuth, AlertController.getAlertById)
  .patch(checkAuth, AlertController.updateAlert)
  .delete(checkAuth, AlertController.deleteAlert);

export default router;
