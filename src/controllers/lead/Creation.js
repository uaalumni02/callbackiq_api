import { AlertService, Db, Lead, Response, SocketService, getBusinessForOwner, isHotLead, leadValidator, ownerEstimate, queryFailure, safeConsole, unknownEstimate } from './context.js';

export default class LeadCreationController {
static async createLead(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await leadValidator.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(
          res,
          "Create a business before creating leads",
        );
      }

      const lead = await Db.saveLead(Lead, {
        ...req.body,
        ...(Object.prototype.hasOwnProperty.call(req.body, "estimatedValue") ? ownerEstimate(req.body.estimatedValue, ownerId) : unknownEstimate()),
        business: business._id,
      });

      SocketService.emitLeadCreated(business._id, lead);
      SocketService.emitDashboardRefresh(business._id, "lead_created");

      if (isHotLead(lead)) {
        await AlertService.createHotLeadAlert({
          businessId: business._id,
          leadId: lead._id,
          customerName: lead.customerName,
          customerPhone: lead.phone,
          score: lead.leadQualityScore,
          urgency: lead.urgency,
          serviceNeeded: lead.serviceNeeded,
          estimatedValue: lead.estimatedValue,
        });
      }

      if (lead.status === "booked") {
        await AlertService.createBookedJobAlert({
          businessId: business._id,
          leadId: lead._id,
          customerName: lead.customerName,
          customerPhone: lead.phone,
          serviceNeeded: lead.serviceNeeded,
          estimatedValue: lead.estimatedValue,
        });
      }

      return res.status(201).json({
        success: true,
        message: "Lead created successfully",
        data: lead,
      });
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in createLead:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      // CALLBACKIQ_SCALE_HARDENING_V1
      // Duplicate/retried customer creation is a conflict, not an internal
      // server failure. Returning 409 prevents retry storms from becoming 5xx
      // storms while the unique tenant/customer identity remains authoritative.
      if (
        Number(error?.code) === 11000 &&
        (error?.keyPattern?.phoneLookup || error?.keyValue?.phoneLookup)
      ) {
        return res.status(409).json({
          success: false,
          message: "A lead already exists for this customer phone number.",
          code: "lead_phone_conflict",
        });
      }

      return Response.responseServerError(res);
    }
  }
}
