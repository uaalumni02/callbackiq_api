import express from "express";

import checkAuth from "../middleware/check-auth.js";
import DashboardController from "../controllers/dashboard.js";

const router = express.Router();

router.get("/", checkAuth, DashboardController.getDashboardMetrics);

router.get(
  "/business/:businessId",
  checkAuth,
  DashboardController.getDashboardMetrics,
);

export default router;
