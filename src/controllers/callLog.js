import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import callLogValidator from "../validator/callLog.js";
import * as Response from "../helpers/response/response.js";

class CallLogController {
  static async createCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await callLogValidator.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.saveCallLog(CallLog, {
        ...req.body,
        business: business._id,
      });

      return res.status(201).json({
        success: true,
        message: "Call log created successfully",
        data: callLog,
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createCallLog:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyCallLogs(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLogs = await Db.getCallLogsByBusiness(CallLog, business._id);

      return Response.responseOk(res, callLogs, "Call logs fetched");
    } catch (error) {
      console.error("Error in getMyCallLogs:", error);
      return Response.responseServerError(res);
    }
  }

  static async getCallLogById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid call log ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.getCallLogById(CallLog, id);

      if (!callLog) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      if (String(callLog.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot access this call log");
      }

      return Response.responseOk(res, callLog, "Call log fetched");
    } catch (error) {
      console.error("Error in getCallLogById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid call log ID");
      }

      await callLogValidator.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.getCallLogById(CallLog, id);

      if (!callLog) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      if (String(callLog.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot update this call log");
      }

      const updatedCallLog = await Db.updateCallLog(CallLog, id, req.body);

      return Response.responseOk(
        res,
        updatedCallLog,
        "Call log updated successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in updateCallLog:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid call log ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.getCallLogById(CallLog, id);

      if (!callLog) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      if (String(callLog.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot delete this call log");
      }

      await Db.deleteCallLog(CallLog, id);

      return res.status(200).json({
        success: true,
        message: "Call log deleted successfully",
      });
    } catch (error) {
      console.error("Error in deleteCallLog:", error);
      return Response.responseServerError(res);
    }
  }
}

export default CallLogController;
