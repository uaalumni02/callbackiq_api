import { safeConsole } from "../helpers/logging/safeLogger.js";
import mongoose from "mongoose";

import DemoRequest from "../models/demoRequest.js";
import { isAdminUser } from "../helpers/model/admin.js";
import * as Response from "../helpers/response/response.js";
import DemoOutreachService from "../services/demoOutreach.service.js";
import SocketService from "../services/socket.service.js";
import {
  demoOutreachAttemptSchema,
  demoOutreachEmailSchema,
} from "../validator/demoOutreach.js";

const emitAdminRefresh = (reason, demo) => {
  if (!SocketService.isInitialized()) return;

  SocketService.emitToAdmins("admin:dashboard:refresh", {
    reason,
    demoRequestId: demo?._id ? String(demo._id) : null,
    occurredAt: new Date().toISOString(),
  });
};

const validateDemoId = (id, res) => {
  if (mongoose.isValidObjectId(id)) return true;
  Response.responseInvalidInput(res, "Invalid demo request ID.");
  return false;
};

class DemoOutreachController {
  static async createContactAttempt(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;
      if (!validateDemoId(id, res)) return undefined;

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

      emitAdminRefresh("demo_contact_attempted", demo);
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

      safeConsole.error("Error in createDemoContactAttempt:", error);
      return Response.responseServerError(res);
    }
  }

  static async sendEmail(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;
      if (!validateDemoId(id, res)) return undefined;

      const payload = await demoOutreachEmailSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await DemoOutreachService.sendEmail({
        DemoRequestModel: DemoRequest,
        demoId: id,
        subject: payload.subject,
        body: payload.body,
        actorId: req.user?.userId || req.user?.id || null,
        actorEmail: req.user?.email || "",
      });

      if (!demo) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      emitAdminRefresh("demo_email_sent", demo);
      return Response.responseOk(res, demo, "Email sent successfully.");
    } catch (error) {
      if (error?.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      if (error?.code === "DEMO_OUTREACH_EMAIL_MISSING") {
        return Response.responseInvalidInput(res, error.message);
      }

      if (error?.code === "DEMO_OUTREACH_EMAIL_SEND_FAILED") {
        return res.status(503).json({
          success: false,
          message: error.message,
        });
      }

      safeConsole.error("Error in sendDemoOutreachEmail:", error);
      return Response.responseServerError(res);
    }
  }
}

export default DemoOutreachController;
