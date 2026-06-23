import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import CallLogController from "../controllers/callLog.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, checkSubscription, CallLogController.createCallLog)
  .get(checkAuth, checkSubscription, CallLogController.getMyCallLogs);

router
  .route("/:id")
  .get(checkAuth, checkSubscription, CallLogController.getCallLogById)
  .patch(checkAuth, checkSubscription, CallLogController.updateCallLog)
  .delete(checkAuth, checkSubscription, CallLogController.deleteCallLog);

export default router;
