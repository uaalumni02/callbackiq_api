import mongoose from "mongoose";

import DemoRequest from "../models/demoRequest.js";
import { isAdminUser } from "../helpers/model/admin.js";
import * as Response from "../helpers/response/response.js";
import DemoBrowserCallService, {
  buildFailureTwiml,
} from "../services/demoBrowserCall.service.js";
import SocketService from "../services/socket.service.js";

const emitAdminRefresh = (reason, demo) => {
  if (!SocketService.isInitialized()) return;
  SocketService.emitToAdmins("admin:dashboard:refresh", {
    reason,
    demoRequestId: demo?._id ? String(demo._id) : null,
    occurredAt: new Date().toISOString(),
  });
};

const invalidDemoId = (id) => !mongoose.isValidObjectId(id);
const clean = (value) => String(value || "").trim();
const ALLOWED_CLIENT_STATUSES = new Set([
  "ready",
  "connecting",
  "connected",
  "disconnected",
  "error",
  "canceled",
]);

const configurationErrorCodes = new Set([
  "DEMO_BROWSER_CALL_ACCOUNT_NOT_CONFIGURED",
  "DEMO_BROWSER_CALL_API_KEY_NOT_CONFIGURED",
  "DEMO_BROWSER_CALL_API_SECRET_NOT_CONFIGURED",
  "DEMO_BROWSER_CALL_APP_NOT_CONFIGURED",
  "DEMO_BROWSER_CALL_CALLER_ID_NOT_CONFIGURED",
  "DEMO_BROWSER_CALL_WEBHOOK_NOT_CONFIGURED",
]);

class DemoBrowserCallController {
  static async createSession(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;
      if (invalidDemoId(id)) {
        return Response.responseInvalidInput(res, "Invalid demo request ID.");
      }

      const result = await DemoBrowserCallService.createSession({
        DemoRequestModel: DemoRequest,
        demoId: id,
        actorId: req.user?.userId || req.user?.id || null,
        actorEmail: req.user?.email || "",
      });

      if (!result?.demo) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      emitAdminRefresh("demo_browser_call_started", result.demo);
      return Response.responseOk(res, result, "Browser call session created.");
    } catch (error) {
      if (error?.code === "DEMO_BROWSER_CALL_PHONE_MISSING") {
        return Response.responseInvalidInput(res, error.message);
      }
      if (error?.code === "DEMO_BROWSER_CALL_ALREADY_ACTIVE") {
        return res.status(409).json({ success: false, message: error.message });
      }
      if (configurationErrorCodes.has(error?.code)) {
        return res.status(503).json({ success: false, message: error.message });
      }

      console.error("Error creating demo browser call session:", error);
      return Response.responseServerError(res);
    }
  }

  static async twiml(req, res) {
    try {
      const demoId = clean(req.body?.demoRequestId);
      const attemptId = clean(req.body?.attemptId);

      if (invalidDemoId(demoId) || !attemptId) {
        return res.type("text/xml").status(200).send(buildFailureTwiml());
      }

      const twiml = await DemoBrowserCallService.buildTwiml({
        DemoRequestModel: DemoRequest,
        demoId,
        attemptId,
        providerCallSid: req.body?.CallSid || "",
      });

      return res.type("text/xml").status(200).send(twiml);
    } catch (error) {
      console.error("Error building demo browser call TwiML:", error);
      return res.type("text/xml").status(200).send(buildFailureTwiml());
    }
  }

  static async prospectStatusWebhook(req, res) {
    try {
      const demoId = clean(req.query?.demoRequestId);
      const attemptId = clean(req.query?.attemptId);
      if (invalidDemoId(demoId) || !attemptId) return res.status(204).send();

      const demo = await DemoBrowserCallService.applyProspectStatus({
        DemoRequestModel: DemoRequest,
        demoId,
        attemptId,
        payload: req.body || {},
      });

      if (demo) emitAdminRefresh("demo_browser_call_status_changed", demo);
      return res.status(204).send();
    } catch (error) {
      console.error("Error handling demo browser call status:", error);
      return res.status(204).send();
    }
  }

  static async clientStatus(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id, attemptId } = req.params;
      if (invalidDemoId(id) || !clean(attemptId)) {
        return Response.responseInvalidInput(res, "Invalid demo call session.");
      }

      const status = clean(req.body?.status).toLowerCase();
      if (!ALLOWED_CLIENT_STATUSES.has(status)) {
        return Response.responseInvalidInput(res, "Invalid browser call status.");
      }

      const demo = await DemoBrowserCallService.applyClientStatus({
        DemoRequestModel: DemoRequest,
        demoId: id,
        attemptId: clean(attemptId),
        status,
        providerCallSid: req.body?.providerCallSid || "",
        errorCode: req.body?.errorCode || "",
      });

      if (!demo) {
        return Response.responseInvalidInput(res, "Demo call session not found.");
      }

      emitAdminRefresh("demo_browser_client_status_changed", demo);
      return Response.responseOk(res, demo, "Browser call status updated.");
    } catch (error) {
      console.error("Error updating demo browser call client status:", error);
      return Response.responseServerError(res);
    }
  }
}

export default DemoBrowserCallController;
