import mongoose from "mongoose";

import getOwnedBusiness from "../services/businessScope.service.js";
import OwnerBrowserCallService, {
  buildFailureTwiml,
} from "../services/ownerBrowserCall.service.js";

const clean = (value) => String(value || "").trim();

const configurationErrorCodes = new Set([
  "OWNER_BROWSER_CALL_ACCOUNT_NOT_CONFIGURED",
  "OWNER_BROWSER_CALL_API_KEY_NOT_CONFIGURED",
  "OWNER_BROWSER_CALL_API_SECRET_NOT_CONFIGURED",
  "OWNER_BROWSER_CALL_APP_NOT_CONFIGURED",
  "OWNER_BROWSER_CALL_WEBHOOK_NOT_CONFIGURED",
]);

const ownerCallParamsFrom = (source = {}) => ({
  callType: clean(source.callType),
  businessId: clean(source.businessId),
  leadId: clean(source.leadId),
  attemptId: clean(source.attemptId),
  expiresAt: clean(source.expiresAt),
  sessionSignature: clean(source.sessionSignature),
});

class OwnerBrowserCallController {
  static async createSession(req, res, next) {
    try {
      const leadId = clean(req.params?.leadId);
      if (!mongoose.isValidObjectId(leadId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid customer ID.",
        });
      }

      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });

      const result = await OwnerBrowserCallService.createSession({
        business,
        leadId,
        actorId: req.user?.userId || req.user?.id || req.user?._id || null,
      });

      if (!result) {
        return res.status(404).json({
          success: false,
          message: "Customer not found.",
        });
      }

      return res.status(200).json({
        success: true,
        data: result,
        message: "Browser call session created.",
      });
    } catch (error) {
      if (error?.code === "OWNER_BROWSER_CALL_PHONE_MISSING") {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }

      if (error?.code === "OWNER_BROWSER_CALL_CALLER_ID_NOT_CONFIGURED") {
        return res.status(409).json({
          success: false,
          message: error.message,
        });
      }

      if (configurationErrorCodes.has(error?.code)) {
        return res.status(503).json({
          success: false,
          message: error.message,
        });
      }

      return next(error);
    }
  }

  static async twiml(req, res) {
    try {
      const twiml = await OwnerBrowserCallService.buildTwiml({
        params: ownerCallParamsFrom(req.body),
      });

      return res.type("text/xml").status(200).send(twiml);
    } catch (error) {
      console.error("Error building owner browser call TwiML:", error);
      return res.type("text/xml").status(200).send(buildFailureTwiml());
    }
  }

  static async prospectStatusWebhook(req, res) {
    try {
      await OwnerBrowserCallService.applyProspectStatus({
        params: ownerCallParamsFrom(req.query),
        payload: req.body || {},
      });
    } catch (error) {
      // Provider callbacks are intentionally acknowledged even when a local
      // audit update fails; Twilio retry storms must not interrupt calls.
      console.error("Error handling owner browser call status:", error);
    }

    return res.status(204).send();
  }
}

export { ownerCallParamsFrom };
export default OwnerBrowserCallController;
