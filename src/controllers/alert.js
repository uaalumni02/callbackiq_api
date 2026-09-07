import { safeConsole } from "../helpers/logging/safeLogger.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Alert from "../models/alert.js";
import { alertSchema, updateAlertSchema } from "../validator/alert.js";
import * as Response from "../helpers/response/response.js";
import AlertService from "../services/alert.service.js";
import SocketService from "../services/socket.service.js";

const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

class AlertController {
  static async createAlert(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const validatedBody = await alertSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const leadId = validatedBody.lead || null;

      if (leadId) {
        const lead = await Db.getLeadForBusiness(Lead, leadId, business._id);

        if (!lead) {
          return Response.responseInvalidInput(res, "Lead not found");
        }
      }

      const result = await AlertService.create({
        businessId: business._id,
        leadId,
        type: validatedBody.type,
        channel: validatedBody.channel,
        title: validatedBody.title,
        message: validatedBody.message,
        status: validatedBody.status,
        priority: validatedBody.priority,
        metadata: validatedBody.metadata,
        dedupeKey: validatedBody.dedupeKey || null,
      });

      return res.status(result.created ? 201 : 200).json({
        success: true,
        message: result.created
          ? "Alert created successfully"
          : "Alert already exists",
        data: result.alert,
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in createAlert:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyAlerts(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { unreadOnly } = req.query;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alerts =
        unreadOnly === "true"
          ? await Db.getUnreadAlertsByBusiness(Alert, business._id)
          : await Db.getAlertsByBusiness(Alert, business._id);

      return Response.responseOk(res, alerts, "Alerts fetched");
    } catch (error) {
      safeConsole.error("Error in getMyAlerts:", error);
      return Response.responseServerError(res);
    }
  }

  static async getAlertById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid alert ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alert = await Db.getAlertForBusiness(Alert, id, business._id);

      if (!alert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      return Response.responseOk(res, alert, "Alert fetched");
    } catch (error) {
      safeConsole.error("Error in getAlertById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateAlert(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid alert ID");
      }

      const validatedBody = await updateAlertSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const updates = {
        ...validatedBody,
      };

      if (validatedBody.status === "read") {
        updates.readAt = new Date();
      } else if (validatedBody.status) {
        updates.readAt = null;
      }

      const updatedAlert = await Db.updateAlertForBusiness(
        Alert,
        id,
        business._id,
        updates,
      );

      if (!updatedAlert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      SocketService.emitAlertUpdated(business._id, updatedAlert);

      return Response.responseOk(
        res,
        updatedAlert,
        "Alert updated successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in updateAlert:", error);
      return Response.responseServerError(res);
    }
  }

  static async markAlertRead(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid alert ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const updatedAlert = await Db.markAlertAsReadForBusiness(
        Alert,
        id,
        business._id,
      );

      if (!updatedAlert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      SocketService.emitAlertUpdated(business._id, updatedAlert);

      return Response.responseOk(res, updatedAlert, "Alert marked as read");
    } catch (error) {
      safeConsole.error("Error in markAlertRead:", error);
      return Response.responseServerError(res);
    }
  }

  static async markAllAlertsRead(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const readAt = new Date();
      const result = await Db.markAllAlertsAsRead(Alert, business._id, readAt);

      SocketService.emitAllAlertsRead(business._id, {
        matchedCount: result.matchedCount ?? 0,
        modifiedCount: result.modifiedCount ?? 0,
        readAt: readAt.toISOString(),
      });

      return Response.responseOk(res, result, "All alerts marked as read");
    } catch (error) {
      safeConsole.error("Error in markAllAlertsRead:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteAlert(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid alert ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const deletedAlert = await Db.deleteAlertForBusiness(
        Alert,
        id,
        business._id,
      );

      if (!deletedAlert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      SocketService.emitAlertDeleted(business._id, id);

      return res.status(200).json({
        success: true,
        message: "Alert deleted successfully",
      });
    } catch (error) {
      safeConsole.error("Error in deleteAlert:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AlertController;
