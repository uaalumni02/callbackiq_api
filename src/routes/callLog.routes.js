import express from "express";

import checkAuth from "../middleware/check-auth.js";
import CallLogController from "../controllers/callLog.js";

const router = express.Router();

router
  .route("/")
  .post(checkAuth, CallLogController.createCallLog)
  .get(checkAuth, CallLogController.getMyCallLogs);

router
  .route("/:id")
  .get(checkAuth, CallLogController.getCallLogById)
  .patch(checkAuth, CallLogController.updateCallLog)
  .delete(checkAuth, CallLogController.deleteCallLog);

export default router;
