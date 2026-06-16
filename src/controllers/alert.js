import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Alert from "../models/alert.js";
import { alertSchema, updateAlertSchema } from "../validator/alert.js";
import * as Response from "../helpers/response/response.js";

class AlertController {
  static async createAlert(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await alertSchema.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      let leadId = req.body.lead || null;

      if (leadId) {
        if (!mongoose.isValidObjectId(leadId)) {
          return Response.responseInvalidInput(res, "Invalid lead ID");
        }

        const lead = await Db.getLeadForBusiness(Lead, leadId, business._id);

        if (!lead) {
          return Response.responseInvalidInput(res, "Lead not found");
        }
      }

      const alert = await Db.saveAlert(Alert, {
        ...req.body,
        lead: leadId,
        business: business._id,
      });

      return res.status(201).json({
        success: true,
        message: "Alert created successfully",
        data: alert,
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createAlert:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alerts =
        unreadOnly === "true"
          ? await Db.getUnreadAlertsByBusiness(Alert, business._id)
          : await Db.getAlertsByBusiness(Alert, business._id);

      return Response.responseOk(res, alerts, "Alerts fetched");
    } catch (error) {
      console.error("Error in getMyAlerts:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alert = await Db.getAlertById(Alert, id);

      if (!alert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      if (String(alert.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot access this alert");
      }

      return Response.responseOk(res, alert, "Alert fetched");
    } catch (error) {
      console.error("Error in getAlertById:", error);
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

      await updateAlertSchema.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alert = await Db.getAlertById(Alert, id);

      if (!alert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      if (String(alert.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot update this alert");
      }

      const updatedAlert = await Db.updateAlert(Alert, id, req.body);

      return Response.responseOk(
        res,
        updatedAlert,
        "Alert updated successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in updateAlert:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alert = await Db.getAlertById(Alert, id);

      if (!alert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      if (String(alert.business._id) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot mark this alert as read",
        );
      }

      const updatedAlert = await Db.markAlertAsRead(Alert, id);

      return Response.responseOk(res, updatedAlert, "Alert marked as read");
    } catch (error) {
      console.error("Error in markAlertRead:", error);
      return Response.responseServerError(res);
    }
  }

  static async markAllAlertsRead(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const result = await Db.markAllAlertsAsRead(Alert, business._id);

      return Response.responseOk(res, result, "All alerts marked as read");
    } catch (error) {
      console.error("Error in markAllAlertsRead:", error);
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const alert = await Db.getAlertById(Alert, id);

      if (!alert) {
        return Response.responseInvalidInput(res, "Alert not found");
      }

      if (String(alert.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot delete this alert");
      }

      await Db.deleteAlert(Alert, id);

      return res.status(200).json({
        success: true,
        message: "Alert deleted successfully",
      });
    } catch (error) {
      console.error("Error in deleteAlert:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AlertController;
