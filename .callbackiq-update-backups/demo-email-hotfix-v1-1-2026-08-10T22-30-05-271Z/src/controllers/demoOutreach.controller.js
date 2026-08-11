import mongoose from "mongoose";

import DemoRequest from "../models/demoRequest.js";
import { isAdminUser } from "../helpers/model/admin.js";
import * as Response from "../helpers/response/response.js";
import DemoOutreachService from "../services/demoOutreach.service.js";
import SocketService from "../services/socket.service.js";
import { demoOutreachAttemptSchema } from "../validator/demoOutreach.js";

const emitAdminRefresh = (demo) => {
  if (!SocketService.isInitialized()) return;

  SocketService.emitToAdmins("admin:dashboard:refresh", {
    reason: "demo_contact_attempted",
    demoRequestId: demo?._id ? String(demo._id) : null,
    occurredAt: new Date().toISOString(),
  });
};

class DemoOutreachController {
  static async createContactAttempt(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid demo request ID.");
      }

      const payload = await demoOutreachAttemptSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await DemoOutreachService.recordAttempt({
        DemoRequestModel: DemoRequest,
        demoId: id,
        channel: payload.channel,
        actorId: req.user?.userId || req.user?.id || null,
        actorEmail: req.user?.email || "",
      });

      if (!demo) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      emitAdminRefresh(demo);
      return Response.responseOk(
        res,
        demo,
        "Contact attempt recorded successfully.",
      );
    } catch (error) {
      if (error?.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      if (
        error?.code === "DEMO_OUTREACH_PHONE_MISSING" ||
        error?.code === "DEMO_OUTREACH_EMAIL_MISSING"
      ) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createDemoContactAttempt:", error);
      return Response.responseServerError(res);
    }
  }
}

export default DemoOutreachController;
