import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import checkActiveBusiness from "../middleware/check-active-business.js";
import LeadController from "../controllers/lead.js";

const router = express.Router();

router
  .route("/")
  .post(
    checkAuth,
    checkActiveBusiness,
    checkSubscription,
    LeadController.createLead,
  )
  .get(
    checkAuth,
    checkActiveBusiness,
    checkSubscription,
    LeadController.getMyLeads,
  );

router.get(
  "/page",
  checkAuth,
  checkActiveBusiness,
  checkSubscription,
  LeadController.getMyLeadsOverview,
);

router.patch(
  "/:id/status",
  checkAuth,
  checkActiveBusiness,
  checkSubscription,
  LeadController.updateLeadStatus,
);

router
  .route("/:id")
  .get(
    checkAuth,
    checkActiveBusiness,
    checkSubscription,
    LeadController.getLeadById,
  )
  .patch(
    checkAuth,
    checkActiveBusiness,
    checkSubscription,
    LeadController.updateLead,
  )
  .delete(
    checkAuth,
    checkActiveBusiness,
    checkSubscription,
    LeadController.deleteLead,
  );

export default router;
