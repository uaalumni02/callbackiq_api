import { AlertService, Db, Lead, Response, SocketService, createHotLeadAlertWhenNeeded, deleteLeadForBusiness, getBusinessForOwner, leadValidator, mongoose, queryFailure, safeConsole, updateLeadForBusiness, updateOwnerLead } from './context.js';

export default class LeadCommandsController {
static async updateLead(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid lead ID");
      }

      await leadValidator.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const lead = await Db.getLeadById(Lead, id);

      if (!lead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      if (String(lead.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot update this lead");
      }

      const previousStatus = lead.status;
      const updatedLead = await updateOwnerLead({ lead, businessId: business._id, changes: req.body, actorId: ownerId });

      if (!updatedLead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      SocketService.emitLeadUpdated(business._id, updatedLead);
      SocketService.emitDashboardRefresh(business._id, "lead_updated");

      await createHotLeadAlertWhenNeeded({
        businessId: business._id,
        previousLead: lead,
        updatedLead,
      });

      if (previousStatus !== "booked" && updatedLead.status === "booked") {
        await AlertService.createBookedJobAlert({
          businessId: business._id,
          leadId: updatedLead._id,
          customerName: updatedLead.customerName,
          customerPhone: updatedLead.phone,
          serviceNeeded: updatedLead.serviceNeeded,
          estimatedValue: updatedLead.estimatedValue,
        });
      }

      return Response.responseOk(res, updatedLead, "Lead updated successfully");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in updateLead:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

static async updateLeadStatus(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;
      const { status } = req.body;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid lead ID");
      }

      const validStatuses = ["new", "contacted", "booked", "lost", "spam"];

      if (!validStatuses.includes(status)) {
        return Response.responseInvalidInput(res, "Invalid lead status");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const lead = await Db.getLeadById(Lead, id);

      if (!lead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      if (String(lead.business._id) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot update this lead status",
        );
      }

      const previousStatus = lead.status;
      const updatedLead = await updateLeadForBusiness(id, business._id, {
        status,
      });

      if (!updatedLead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      SocketService.emitLeadUpdated(business._id, updatedLead);
      SocketService.emitDashboardRefresh(business._id, "lead_status_updated");

      if (previousStatus !== "booked" && updatedLead.status === "booked") {
        await AlertService.createBookedJobAlert({
          businessId: business._id,
          leadId: updatedLead._id,
          customerName: updatedLead.customerName,
          customerPhone: updatedLead.phone,
          serviceNeeded: updatedLead.serviceNeeded,
          estimatedValue: updatedLead.estimatedValue,
        });
      }

      return Response.responseOk(
        res,
        updatedLead,
        "Lead status updated successfully",
      );
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in updateLeadStatus:", error);
      return Response.responseServerError(res);
    }
  }

static async deleteLead(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid lead ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const lead = await Db.getLeadById(Lead, id);

      if (!lead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      if (String(lead.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot delete this lead");
      }

      await deleteLeadForBusiness(id, business._id);

      SocketService.emitToBusiness(business._id, "lead:deleted", {
        leadId: id,
        deletedAt: new Date().toISOString(),
      });

      SocketService.emitDashboardRefresh(business._id, "lead_deleted");

      return res.status(200).json({
        success: true,
        message: "Lead deleted successfully",
      });
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in deleteLead:", error);
      return Response.responseServerError(res);
    }
  }
}
