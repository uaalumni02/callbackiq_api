import { Business, buildGoogleAuthorizationUrl, exchangeGoogleAuthorizationCode, frontendBaseUrl, getGoogleConnection, getOwnedBusiness, listGoogleCalendars, publicStatus } from './context.js';

export default class IntegrationGoogleConnectionController {
static async googleConnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const authorizationUrl = await buildGoogleAuthorizationUrl(
        business._id,
        req.user?.userId,
      );
      return res.status(200).json({
        success: true,
        data: { authorizationUrl },
      });
    } catch (error) {
      return next(error);
    }
  }

static async googleCallback(req, res) {
    const frontendUrl = frontendBaseUrl();
    try {
      if (!req.query.code || !req.query.state) {
        throw new Error(
          "Google did not return an authorization code and state.",
        );
      }
      const { businessId } = await exchangeGoogleAuthorizationCode({
        code: req.query.code,
        state: req.query.state,
      });
      await Business.updateOne(
        { _id: businessId },
        {
          $set: {
            "integrations.calendar.provider": "google",
            "integrations.calendar.status": "connected",
            "integrations.calendar.verified": false,
            "integrations.calendar.verifiedAt": null,
          },
        },
      );
      return res.redirect(`${frontendUrl}/integrations?google=connected`);
    } catch (error) {
      const message = encodeURIComponent(
        error.message || "Google Calendar connection failed",
      );
      return res.redirect(
        `${frontendUrl}/integrations?google=error&message=${message}`,
      );
    }
  }

static async googleStatus(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const connection = await getGoogleConnection(business._id);
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

static async googleCalendars(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const calendars = await listGoogleCalendars(business._id, true);
      return res.status(200).json({ success: true, data: calendars });
    } catch (error) {
      return next(error);
    }
  }
}
