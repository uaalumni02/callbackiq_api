import express from "express";
import AvailabilityController from "../controllers/availability.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
const router = express.Router();
router.get("/", checkAuth, checkSubscription, AvailabilityController.list);
export default router;
