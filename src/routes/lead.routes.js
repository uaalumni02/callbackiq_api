import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import LeadController from "../controllers/lead.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, checkSubscription, LeadController.createLead)
  .get(checkAuth, LeadController.getMyLeads);

router.patch(
  "/:id/status",
  checkAuth,
  checkSubscription,
  LeadController.updateLeadStatus,
);

router
  .route("/:id")
  .get(checkAuth, LeadController.getLeadById)
  .patch(checkAuth, checkSubscription, LeadController.updateLead)
  .delete(checkAuth, checkSubscription, LeadController.deleteLead);

export default router;
