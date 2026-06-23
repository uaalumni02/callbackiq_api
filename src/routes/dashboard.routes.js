import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkActiveBusiness from "../middleware/check-active-business.js";
import DashboardController from "../controllers/dashboard.js";

const router = express.Router();

router.get(
  "/",
  checkAuth,
  checkActiveBusiness,
  DashboardController.getDashboardMetrics,
);

router.get(
  "/business/:businessId",
  checkAuth,
  checkActiveBusiness,
  DashboardController.getDashboardMetrics,
);

export default router;
