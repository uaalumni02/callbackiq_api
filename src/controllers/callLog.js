import { queryFailure } from "../services/scale/queryBudget.js";
import { safeConsole } from "../helpers/logging/safeLogger.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import callLogValidator from "../validator/callLog.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";
import {
  getCallLogsOverview,
  getCallLogsPage,
  setPaginationHeaders,
} from "../services/cursorPagination.service.js";

const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const updateCallLogForBusiness = async (id, businessId, data) => {
  if (typeof Db.updateCallLogForBusiness === "function") {
    return Db.updateCallLogForBusiness(CallLog, id, businessId, data);
  }

  return Db.updateCallLog(CallLog, id, data);
};

const deleteCallLogForBusiness = async (id, businessId) => {
  if (typeof Db.deleteCallLogForBusiness === "function") {
    return Db.deleteCallLogForBusiness(CallLog, id, businessId);
  }

  return Db.deleteCallLog(CallLog, id);
};


class CallLogController {
  static async createCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await callLogValidator.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

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
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in createCallLog:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyCallLogs(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const page = await getCallLogsPage(business._id, req.query);
      setPaginationHeaders(res, page);
      return Response.responseOk(res, page.items, "Call logs fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyCallLogs:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyCallLogsOverview(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const data = await getCallLogsOverview(business._id, req.query);
      return Response.responseOk(res, data, "Call log page fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyCallLogsOverview:", error);
      if (error?.code === "INVALID_CURSOR") {
        return Response.responseInvalidInput(res, "Invalid pagination cursor");
      }
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

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.getCallLogById(CallLog, id);

      if (!callLog || callLog.deletedAt) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      if (String(callLog.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot access this call log");
      }

      return Response.responseOk(res, callLog, "Call log fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getCallLogById:", error);
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

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.getCallLogById(CallLog, id);

      if (!callLog || callLog.deletedAt) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      if (String(callLog.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot update this call log");
      }

      const updatedCallLog = await updateCallLogForBusiness(id, business._id, req.body);

      if (!updatedCallLog) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      return Response.responseOk(
        res,
        updatedCallLog,
        "Call log updated successfully",
      );
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in updateCallLog:", error);
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

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog = await Db.getCallLogById(CallLog, id);

      if (!callLog || callLog.deletedAt) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      if (String(callLog.business._id) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot delete this call log");
      }

      // CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2:
      // Hide the operational record without destroying attribution history.
      const deleted = await CallLog.findOneAndUpdate(
        { _id: id, business: business._id, deletedAt: null },
        {
          $set: {
            deletedAt: new Date(),
            deletedBy: ownerId,
            deletionReason: "Deleted from Call Activity",
          },
        },
        { returnDocument: "after" },
      );

      if (!deleted) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      SocketService.emitToBusiness(business._id, "call:deleted", {
        callId: id,
        deletedAt: deleted.deletedAt,
      });
      SocketService.emitDashboardRefresh(business._id, "call_log_hidden");

      return res.status(200).json({
        success: true,
        message: "Call log hidden successfully",
      });
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in deleteCallLog:", error);
      return Response.responseServerError(res);
    }
  }
}

export default CallLogController;