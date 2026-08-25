// CALLBACKIQ_SCALE_HARDENING_V1
import getOwnedBusiness from "../services/businessScope.service.js";
import OwnerExperienceService from "../services/ownerExperience.service.js";
import RevenueRecoveryService from "../services/analytics/revenueRecovery.service.js";
import ScaleCache from "../services/scaleCache.service.js";

const cacheNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

class OwnerExperienceController {
  static async dashboard(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const period = req.query.period || "today";

      const data = await ScaleCache.getOrLoad({
        key: `owner-dashboard:${business._id}:${period}`,
        ttlMs: cacheNumber("OWNER_DASHBOARD_CACHE_TTL_MS", 5000),
        staleMs: cacheNumber("OWNER_DASHBOARD_CACHE_STALE_MS", 20000),
        loader: async () => {
          const [dashboard, marketingSources] = await Promise.all([
            OwnerExperienceService.dashboard({ business, period }),
            RevenueRecoveryService.marketingSources({
              businessId: business._id,
            }),
          ]);

          return {
            ...dashboard,
            marketingSources,
          };
        },
      });

      res.setHeader(
        "Cache-Control",
        "private, max-age=2, stale-while-revalidate=10",
      );
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async opportunities(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const data = await OwnerExperienceService.opportunities({
        business,
        view: req.query.view || req.query.state || "active",
        search: req.query.search || "",
        limit: req.query.limit || 50,
        skip: req.query.skip || 0,
      });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }
}

export default OwnerExperienceController;
