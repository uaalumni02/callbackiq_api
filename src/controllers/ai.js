import { safeConsole } from "../helpers/logging/safeLogger.js";
import { beginValuation, finishValuation } from "../services/valuation/opportunityValuation.service.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import qualifyLeadSchema from "../validator/ai.js";
import { qualifyLeadWithAI } from "../helpers/ai/openaiClient.js";
import * as Response from "../helpers/response/response.js";
import AlertService from "../services/alert.service.js";
import SocketService from "../services/socket.service.js";

const sanitizeUrgency = (urgency) => {
  const allowed = ["low", "medium", "high", "emergency"];

  return allowed.includes(urgency) ? urgency : "medium";
};

const sanitizeScore = (score) => {
  const numberScore = Number(score);

  if (Number.isNaN(numberScore)) return 50;

  return Math.min(100, Math.max(0, numberScore));
};

const sanitizeEstimatedValue = (value) => {
  const numberValue = Number(value);

  if (Number.isNaN(numberValue)) return 0;

  return Math.max(0, numberValue);
};

const isHotLead = (lead) => {
  return (
    Number(lead?.leadQualityScore || 0) >= 80 || lead?.urgency === "emergency"
  );
};

class AiController {
  static async qualifyLead(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await qualifyLeadSchema.validateAsync(req.body);

      const { leadId, messageBody } = req.body;

      if (!mongoose.isValidObjectId(leadId)) {
        return Response.responseInvalidInput(res, "Invalid lead ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const lead = await Db.getLeadForBusiness(Lead, leadId, business._id);

      if (!lead) {
        return Response.responseInvalidInput(res, "Lead not found");
      }

      const wasHotLead = isHotLead(lead);

      const valuationTicket = await beginValuation(lead, business._id);
      const aiResult = await qualifyLeadWithAI({
        messageBody,
        businessType: business.businessType,
        business,
      });

      if (["prompt_injection", "off_topic", "possible_spam"].includes(aiResult.messageCategory)) {
        return Response.responseOk(res, { lead, aiResult: { messageCategory: aiResult.messageCategory } }, "Message was not eligible for lead qualification");
      }
      const updateData = {
        aiExtraction: { source: "owner_qualification", observedAt: new Date(), verified: false },
        serviceNeeded:
          aiResult.serviceNeeded || lead.serviceNeeded || "Unknown service",
        urgency: sanitizeUrgency(aiResult.urgency),
        address: aiResult.address || lead.address || "",
        preferredAppointmentTime:
          aiResult.preferredAppointmentTime ||
          lead.preferredAppointmentTime ||
          "",
        leadQualityScore: sanitizeScore(aiResult.leadQualityScore),
        summary: aiResult.summary || lead.summary || "",
        status: lead.status === "booked" ? "booked" : "contacted",
      };

      let qualifiedLead = await Db.qualifyLead(Lead, leadId, updateData);
      qualifiedLead = await finishValuation(valuationTicket, { businessId: business._id, evidence: messageBody, proposedService: aiResult.serviceNeeded }) || qualifiedLead;

      SocketService.emitLeadUpdated(business._id, qualifiedLead);
      SocketService.emitDashboardRefresh(business._id, "lead_qualified");

      if (!wasHotLead && isHotLead(qualifiedLead)) {
        await AlertService.createHotLeadAlert({
          businessId: business._id,
          leadId: qualifiedLead._id,
          customerName: qualifiedLead.customerName,
          customerPhone: qualifiedLead.phone,
          score: qualifiedLead.leadQualityScore,
          urgency: qualifiedLead.urgency,
          serviceNeeded: qualifiedLead.serviceNeeded,
          estimatedValue: qualifiedLead.estimatedValue,
        });
      }

      return Response.responseOk(
        res,
        {
          lead: qualifiedLead,
          aiResult: updateData,
        },
        "Lead qualified successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in qualifyLead:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AiController;
