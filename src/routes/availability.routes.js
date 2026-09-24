import express from "express";
import AvailabilityController from "../controllers/availability.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
const router = express.Router();
router.get("/", checkAuth, checkSubscription, AvailabilityController.list);
router.get("/full-today", checkAuth, checkSubscription, AvailabilityController.fullToday);
router.post("/full-today", checkAuth, checkSubscription, AvailabilityController.fullToday);
export default router;
