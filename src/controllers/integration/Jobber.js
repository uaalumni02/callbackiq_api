import Business from "../../models/business.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import JobberProvider from "../../integrations/scheduling/jobber.provider.js";
import { buildJobberAuthorizationUrl, disconnectJobber, exchangeJobberAuthorizationCode } from "../../services/integrations/jobberOAuth.service.js";
import { frontendBaseUrl, publicStatus } from "./helpers.js";
import getOwnedBusiness from "../../services/businessScope.service.js";

export default class IntegrationJobberController {
static async jobberConnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const authorizationUrl = await buildJobberAuthorizationUrl(business._id);
      return res.status(200).json({
        success: true,
        data: { authorizationUrl },
      });
    } catch (error) {
      return next(error);
    }
  }

static async jobberCallback(req, res) {
    const frontendUrl = frontendBaseUrl();
    try {
      if (!req.query.code || !req.query.state) {
        throw new Error(
          "Jobber did not return an authorization code and state.",
        );
      }
      const { businessId } = await exchangeJobberAuthorizationCode({
        code: req.query.code,
        state: req.query.state,
      });
      await Business.updateOne(
        { _id: businessId },
        {
          $set: {
            "integrations.dispatch.provider": "jobber",
            "integrations.dispatch.status": "connected",
            "integrations.dispatch.verified": true,
            "integrations.dispatch.verifiedAt": new Date(),
          },
        },
      );
      return res.redirect(`${frontendUrl}/integrations?jobber=connected`);
    } catch (error) {
      const message = encodeURIComponent(
        error.message || "Jobber connection failed",
      );
      return res.redirect(
        `${frontendUrl}/integrations?jobber=error&message=${message}`,
      );
    }
  }

static async jobberDisconnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const connection = await disconnectJobber(business._id);
      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            "integrations.dispatch.provider": "",
            "integrations.dispatch.status": "disconnected",
            "integrations.dispatch.verified": false,
            "integrations.dispatch.verifiedAt": null,
          },
        },
      );
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

static async jobberStatus(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const connection = await IntegrationConnection.findOne({
        business: business._id,
        provider: "jobber",
      });
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

static async jobberTest(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const result = await new JobberProvider({ business }).testConnection();
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }
}
