// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import getOwnedBusiness from "../services/businessScope.service.js";
import {
  archiveMarketingSource,
  createMarketingSource,
  listMarketingSources,
  provisionMarketingTrackingNumber,
  releaseMarketingTrackingNumber,
  updateMarketingSource,
} from "../services/marketingSource.service.js";
import { getAttributionReport } from "../services/marketingAttributionReport.service.js";

const ownedBusiness = (req) =>
  getOwnedBusiness({
    user: req.user,
    requestedBusinessId: req.query.businessId,
  });

const sendKnownError = (res, error) =>
  res.status(error?.statusCode || 500).json({
    success: false,
    code: error?.code || "MARKETING_ATTRIBUTION_ERROR",
    message: error?.message || "Marketing attribution request failed.",
  });

class MarketingAttributionController {
  static async report(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await getAttributionReport({
        businessId: business._id,
        start: req.query.start,
        end: req.query.end,
      });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }
  static async list(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await listMarketingSources({ businessId: business._id });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }

  static async create(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await createMarketingSource({
        businessId: business._id,
        name: req.body?.name,
        channel: req.body?.channel,
        campaign: req.body?.campaign,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error?.statusCode || error?.code === 11000) {
        return sendKnownError(res, error);
      }
      return next(error);
    }
  }

  static async update(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await updateMarketingSource({
        businessId: business._id,
        sourceId: req.params.id,
        updates: req.body || {},
      });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }

  static async provisionNumber(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await provisionMarketingTrackingNumber({
        businessId: business._id,
        sourceId: req.params.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }
  static async releaseNumber(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await releaseMarketingTrackingNumber({
        businessId: business._id,
        sourceId: req.params.id,
      });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }

  static async archive(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await archiveMarketingSource({
        businessId: business._id,
        sourceId: req.params.id,
      });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }
}

export default MarketingAttributionController;
