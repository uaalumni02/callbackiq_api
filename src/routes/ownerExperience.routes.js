import express from "express";

import OwnerExperienceController from "../controllers/ownerExperience.js";
import checkAuth from "../middleware/check-auth.js";
import checkActiveBusiness from "../middleware/check-active-business.js";
import checkSubscription from "../middleware/check-subscription.js";

const router = express.Router();

router.use(checkAuth, checkActiveBusiness, checkSubscription);
router.get("/dashboard", OwnerExperienceController.dashboard);
router.get("/opportunities", OwnerExperienceController.opportunities);

export default router;
