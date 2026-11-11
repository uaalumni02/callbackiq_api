import { queryFailure } from "../../services/scale/queryBudget.js";

import { safeConsole } from "../../helpers/logging/safeLogger.js";

import { updateOwnerLead, ownerEstimate, unknownEstimate } from "../../services/valuation/opportunityValuation.service.js";

import mongoose from "mongoose";

import Db from "../../db/db.js";

import Lead from "../../models/lead.js";

import Business from "../../models/business.js";

import leadValidator from "../../validator/lead.js";

import * as Response from "../../helpers/response/response.js";

import AlertService from "../../services/alert.service.js";

import SocketService from "../../services/socket.service.js";

import {
  getLeadsOverview,
  getLeadsPage,
  setPaginationHeaders,
} from "../../services/cursorPagination.service.js";

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

export { AlertService, Db, Lead, Response, SocketService, getBusinessForOwner, isHotLead, leadValidator, ownerEstimate, queryFailure, safeConsole, unknownEstimate, getLeadsPage, setPaginationHeaders, getLeadsOverview, mongoose, createHotLeadAlertWhenNeeded, updateOwnerLead, updateLeadForBusiness, deleteLeadForBusiness };
