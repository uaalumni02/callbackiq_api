import express from "express";

import checkAuth from "../middleware/check-auth.js";
import LeadController from "../controllers/lead.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, LeadController.createLead)
  .get(checkAuth, LeadController.getMyLeads);

router.route("/:id").get(checkAuth, LeadController.getLeadById);

router.route("/:id").patch(checkAuth, LeadController.updateLead);

router.route("/:id/status").patch(checkAuth, LeadController.updateLeadStatus);

router.route("/:id").delete(checkAuth, LeadController.deleteLead);

export default router;
