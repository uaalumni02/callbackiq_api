// CALLBACKIQ_SCALE_HARDENING_V1
import mongoose from "mongoose";
import getOwnedBusiness from "../services/businessScope.service.js";
import RevenueRecoveryService from "../services/analytics/revenueRecovery.service.js";
import ScaleCache from "../services/scaleCache.service.js";

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

const cacheNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const contextKey = (context) =>
  [
    String(context.businessId),
    context.startDate || "default-start",
    context.endDate || "default-end",
  ].join(":");

const cached = async (namespace, context, loader, ttlMs = 15000) =>
  ScaleCache.getOrLoad({
    key: `revenue:${namespace}:${contextKey(context)}`,
    ttlMs,
    staleMs: cacheNumber("ANALYTICS_CACHE_STALE_MS", 60000),
    loader,
  });

const funnelFromSummary = (summary) => [
  { stage: "Missed inquiries", count: summary.missedCalls },
  { stage: "Customers reached", count: summary.customersReached },
  { stage: "Qualified leads", count: summary.qualifiedLeads },
  { stage: "Appointments booked", count: summary.appointmentsBooked },
  { stage: "Recovered leads", count: summary.recoveredLeads },
];

class RevenueRecoveryController {
  static async summary(req, res, next) {
    try {
      const context = await getContext(req);
      const data = await cached(
        "summary",
        context,
        () => RevenueRecoveryService.summary(context),
        cacheNumber("ANALYTICS_SUMMARY_CACHE_TTL_MS", 10000),
      );
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async trends(req, res, next) {
    try {
      const context = await getContext(req);
      const data = await cached(
        "trends",
        context,
        () => RevenueRecoveryService.trends(context),
      );
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async sources(req, res, next) {
    try {
      const context = await getContext(req);
      const data = await cached(
        "sources",
        context,
        () => RevenueRecoveryService.sources(context),
      );
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async marketingSources(req, res, next) {
    try {
      const context = await getContext(req);
      const data = await cached(
        "marketing-sources",
        context,
        () => RevenueRecoveryService.marketingSources(context),
      );
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async lost(req, res, next) {
    try {
      const context = await getContext(req);
      // Preserve the existing controller/service contract: the service receives
      // the query-string value as-is and owns limit normalization/clamping.
      const rawLimit = req.query.limit;
      const cacheLimit = Math.min(Math.max(Number(rawLimit) || 100, 1), 250);
      const data = await ScaleCache.getOrLoad({
        key: `revenue:lost:${contextKey(context)}:${cacheLimit}`,
        ttlMs: cacheNumber("ANALYTICS_CACHE_TTL_MS", 15000),
        staleMs: cacheNumber("ANALYTICS_CACHE_STALE_MS", 60000),
        loader: () =>
          RevenueRecoveryService.lostOpportunities({
            ...context,
            limit: rawLimit,
          }),
      });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async funnel(req, res, next) {
    try {
      const context = await getContext(req);
      // Keep the public controller contract intact. The consolidated overview
      // endpoint still derives its funnel from the already-loaded summary so it
      // avoids duplicate database work inside that request.
      const data = await cached(
        "funnel",
        context,
        () => RevenueRecoveryService.funnel(context),
      );
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async overview(req, res, next) {
    try {
      const context = await getContext(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

      const data = await ScaleCache.getOrLoad({
        key: `revenue:overview:${contextKey(context)}:${limit}`,
        ttlMs: cacheNumber("ANALYTICS_OVERVIEW_CACHE_TTL_MS", 15000),
        staleMs: cacheNumber("ANALYTICS_CACHE_STALE_MS", 60000),
        loader: async () => {
          const [summary, trends, sources, marketingSources, lost] =
            await Promise.all([
              RevenueRecoveryService.summary(context),
              RevenueRecoveryService.trends(context),
              RevenueRecoveryService.sources(context),
              RevenueRecoveryService.marketingSources(context),
              RevenueRecoveryService.lostOpportunities({
                ...context,
                limit,
              }),
            ]);

          return {
            summary,
            trends,
            funnel: funnelFromSummary(summary),
            sources,
            marketingSources,
            lost,
          };
        },
      });

      res.setHeader(
        "Cache-Control",
        "private, max-age=5, stale-while-revalidate=30",
      );
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }
}

export default RevenueRecoveryController;
