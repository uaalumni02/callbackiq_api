import mongoose from "mongoose";

import Db from "../db/db.js";
import Lead from "../models/lead.js";
import Business from "../models/business.js";
import leadValidator from "../validator/lead.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";

class LeadController {
  static async createLead(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await leadValidator.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(
          res,
          "Create a business before creating leads",
        );
      }

      const lead = await Db.saveLead(Lead, {
        ...req.body,
        business: business._id,
      });

      SocketService.emitLeadCreated(business._id, lead);
      SocketService.emitDashboardRefresh(business._id, "lead_created");

      return res.status(201).json({
        success: true,
        message: "Lead created successfully",
        data: lead,
      });
    } catch (error) {
      console.error("Error in createLead:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const leads = await Db.getLeadsByBusiness(Lead, business._id);

      return Response.responseOk(res, leads, "Leads fetched");
    } catch (error) {
      console.error("Error in getMyLeads:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const lead = await Db.getLeadById(Lead, id);

      if (!lead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      if (String(lead.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot access this lead");
      }

      return Response.responseOk(res, lead, "Lead fetched");
    } catch (error) {
      console.error("Error in getLeadById:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

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

      const updatedLead = await Db.updateLead(Lead, id, req.body);

      SocketService.emitLeadUpdated(business._id, updatedLead);
      SocketService.emitDashboardRefresh(business._id, "lead_updated");

      return Response.responseOk(res, updatedLead, "Lead updated successfully");
    } catch (error) {
      console.error("Error in updateLead:", error);

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

      const business = await Db.getBusinessByOwner(Business, ownerId);

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

      const updatedLead = await Db.updateLead(Lead, id, { status });

      SocketService.emitLeadUpdated(business._id, updatedLead);
      SocketService.emitDashboardRefresh(business._id, "lead_status_updated");

      return Response.responseOk(
        res,
        updatedLead,
        "Lead status updated successfully",
      );
    } catch (error) {
      console.error("Error in updateLeadStatus:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

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

      await Db.deleteLead(Lead, id);

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
      console.error("Error in deleteLead:", error);
      return Response.responseServerError(res);
    }
  }
}

export default LeadController;
