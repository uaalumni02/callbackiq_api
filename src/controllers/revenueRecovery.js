import mongoose from "mongoose";
import getOwnedBusiness from "../services/businessScope.service.js";
import RevenueRecoveryService from "../services/analytics/revenueRecovery.service.js";

const getContext = async (req) => {
  const business = await getOwnedBusiness({
    user: req.user,
    requestedBusinessId: req.query.businessId,
  });
  return {
    businessId: new mongoose.Types.ObjectId(String(business._id)),
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  };
};

class RevenueRecoveryController {
  static async summary(req, res, next) {
    try { return res.json({ success: true, data: await RevenueRecoveryService.summary(await getContext(req)) }); }
    catch (error) { return next(error); }
  }
  static async trends(req, res, next) {
    try { return res.json({ success: true, data: await RevenueRecoveryService.trends(await getContext(req)) }); }
    catch (error) { return next(error); }
  }
  static async sources(req, res, next) {
    try { return res.json({ success: true, data: await RevenueRecoveryService.sources(await getContext(req)) }); }
    catch (error) { return next(error); }
  }
  static async lost(req, res, next) {
    try {
      const context = await getContext(req);
      return res.json({ success: true, data: await RevenueRecoveryService.lostOpportunities({ ...context, limit: req.query.limit }) });
    } catch (error) { return next(error); }
  }
  static async funnel(req, res, next) {
    try { return res.json({ success: true, data: await RevenueRecoveryService.funnel(await getContext(req)) }); }
    catch (error) { return next(error); }
  }
}

export default RevenueRecoveryController;
