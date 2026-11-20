import {readTenantResource} from '../shared/tenantResource.js';
import AlertService from "../../services/alert.service.js";
import Lead from "../../models/lead.js";
import * as Response from "../../helpers/response/response.js";
import SocketService from "../../services/socket.service.js";
import { createHotLeadAlertWhenNeeded, deleteLeadForBusiness, getBusinessForOwner, updateLeadForBusiness } from "./helpers.js";
import leadValidator from "../../validator/lead.js";
import mongoose from "mongoose";
import { queryFailure } from "../../services/scale/queryBudget.js";
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import { updateOwnerLead } from "../../services/valuation/opportunityValuation.service.js";

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

      const lead=await readTenantResource({model:Lead,businessId:business._id,id:id,res,
        missingMessage:"Lead not found",deniedMessage:"You cannot update this lead"});
      if(!lead)return undefined;

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

      const lead=await readTenantResource({model:Lead,businessId:business._id,id:id,res,
        missingMessage:"Lead not found",deniedMessage:"You cannot update this lead status"});
      if(!lead)return undefined;

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

      const lead=await readTenantResource({model:Lead,businessId:business._id,id:id,res,
        missingMessage:"Lead not found",deniedMessage:"You cannot delete this lead"});
      if(!lead)return undefined;

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
