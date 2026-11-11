import { Db, Lead, Response, getBusinessForOwner, getLeadsOverview, getLeadsPage, mongoose, queryFailure, safeConsole, setPaginationHeaders } from './context.js';

export default class LeadReadsController {
static async getMyLeads(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      // CALLBACKIQ_LEAD_CURSOR_PAGINATION_V1
      const page = await getLeadsPage(business._id, req.query);
      setPaginationHeaders(res, page);
      return Response.responseOk(res, page.items, "Leads fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyLeads:", error);
      return Response.responseServerError(res);
    }
  }

static async getMyLeadsOverview(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const data = await getLeadsOverview(business._id, req.query);
      return Response.responseOk(res, data, "Lead page fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyLeadsOverview:", error);
      if (error?.code === "INVALID_CURSOR") {
        return Response.responseInvalidInput(res, "Invalid pagination cursor");
      }
      return Response.responseServerError(res);
    }
  }

static async getLeadById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid lead ID");
      }

      /*
       * Protected lead routes have already resolved the tenant business in
       * checkActiveBusiness/checkSubscription. Reuse that request-scoped
       * document instead of issuing another Business lookup.
       */
      const business =
        req.business ||
        (await getBusinessForOwner(ownerId));

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      /*
       * The authenticated Business is already request-scoped. Avoid another
       * Business populate solely for tenant comparison/serialization.
       */
      const lead = await Db.getLeadById(
        Lead,
        id,
        {
          populateBusiness: false,
          lean: true,
        },
      );

      if (!lead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      const leadBusinessId =
        lead.business?._id ||
        lead.business;

      if (String(leadBusinessId) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot access this lead");
      }

      const payload = {
        ...lead,
        business: {
          _id: business._id,
          businessName: business.businessName,
          businessType: business.businessType,
          phone: business.phone,
        },
      };

      return Response.responseOk(res, payload, "Lead fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getLeadById:", error);
      return Response.responseServerError(res);
    }
  }
}
