import { safeConsole } from "../helpers/logging/safeLogger.js";
import { updateOwnerLead, ownerEstimate, unknownEstimate } from "../services/valuation/opportunityValuation.service.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Lead from "../models/lead.js";
import Business from "../models/business.js";
import leadValidator from "../validator/lead.js";
import * as Response from "../helpers/response/response.js";
import AlertService from "../services/alert.service.js";
import SocketService from "../services/socket.service.js";

import {
  getLeadsOverview,
  getLeadsPage,
  setPaginationHeaders,
} from "../services/cursorPagination.service.js";
const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const updateLeadForBusiness = async (id, businessId, data) => {
  if (typeof Db.updateLeadForBusiness === "function") {
    return Db.updateLeadForBusiness(Lead, id, businessId, data);
  }

  return Db.updateLead(Lead, id, data);
};

const deleteLeadForBusiness = async (id, businessId) => {
  if (typeof Db.deleteLeadForBusiness === "function") {
    return Db.deleteLeadForBusiness(Lead, id, businessId);
  }

  return Db.deleteLead(Lead, id);
};

const isHotLead = (lead) => {
  return (
    Number(lead?.leadQualityScore || 0) >= 80 || lead?.urgency === "emergency"
  );
};

const createHotLeadAlertWhenNeeded = async ({
  businessId,
  previousLead,
  updatedLead,
}) => {
  if (!updatedLead || isHotLead(previousLead) || !isHotLead(updatedLead)) {
    return;
  }

  await AlertService.createHotLeadAlert({
    businessId,
    leadId: updatedLead._id,
    customerName: updatedLead.customerName,
    customerPhone: updatedLead.phone,
    score: updatedLead.leadQualityScore,
    urgency: updatedLead.urgency,
    serviceNeeded: updatedLead.serviceNeeded,
    estimatedValue: updatedLead.estimatedValue,
  });
};

class LeadController {
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
      safeConsole.error("Error in getLeadById:", error);
      return Response.responseServerError(res);
    }
  }

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
      safeConsole.error("Error in deleteLead:", error);
      return Response.responseServerError(res);
    }
  }
}

export default LeadController;
