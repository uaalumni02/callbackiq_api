import { safeConsole } from "../helpers/logging/safeLogger.js";
import { verifiedAmount } from "../services/valuation/opportunityValue.js";
import mongoose from "mongoose";

import Business from "../models/business.js";
import Lead from "../models/lead.js";
import { readCustomerDetail, readCustomerHistory } from "../services/scale/customerHistory.service.js";
import { queryBudgetMs, queryFailure } from "../services/scale/queryBudget.js";

const asId = (value) => value?._id || value?.id || value;

const maxMoney = (...values) =>
  Math.max(0, ...values.flat().map((value) => Number(value) || 0));

class CustomerRecoveryController {
  static async getRecoveryDetail(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { leadId } = req.params;

      if (!ownerId) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      if (!mongoose.isValidObjectId(leadId)) {
        return res.status(400).json({ success: false, message: "Invalid customer ID" });
      }

      const business = await Business.findOne({ owner: ownerId }).maxTimeMS(queryBudgetMs()).lean();
      if (!business) {
        return res.status(404).json({ success: false, message: "Business not found" });
      }

      const lead = await Lead.findOne({
        _id: leadId,
        business: business._id,
      }).maxTimeMS(queryBudgetMs()).lean();
      if (!lead) {
        return res.status(404).json({ success: false, message: "Customer not found" });
      }

      if (req.query?.section) {
        const page = await readCustomerHistory({ businessId: business._id, lead,
          section: req.query.section, cursor: req.query.cursor, limit: req.query.limit });
        return res.status(200).json({ success: true, data: page });
      }
      const { pages, summary } = await readCustomerDetail({ businessId: business._id, lead, limit: req.query?.limit });
      const { conversations, messages, calls, appointments, voiceSessions, interventions, intelligence, conversionEvents } =
        Object.fromEntries(Object.entries(pages).map(([key, page]) => [key, page.items]));
      const customerLifecycleStatus = summary.customerLifecycleStatus;

      // Derive one lifecycle value from authoritative history. A read never
      // updates stored records or their timestamps.
      const withLifecycle = (items = []) =>
        items.map((item) => ({ ...item, customerLifecycleStatus }));
      const canonicalConversations = withLifecycle(conversations);
      const canonicalAppointments = withLifecycle(appointments);
      const canonicalVoiceSessions = withLifecycle(voiceSessions);
      const canonicalInterventions = withLifecycle(interventions);

      const currentAppointment = (summary.appointment && withLifecycle([summary.appointment])[0]) ||
        canonicalAppointments.find((item) =>
          ["held", "confirmed", "rescheduled"].includes(item.status),
        ) ||
        canonicalAppointments[0] ||
        null;
      const activeIntervention = (summary.intervention && withLifecycle([summary.intervention])[0]) ||
        canonicalInterventions.find(
          (item) => !item.resolvedAt && item.actionRequired,
        ) ||
        canonicalInterventions.find((item) => !item.resolvedAt) ||
        null;
      const latestIntelligence = summary.intelligence || intelligence[0] || null;

      const actualRevenue = summary.appointmentCount ? summary.actualRevenue : maxMoney(lead.actualRevenue);
      const estimatedRevenue = summary.confirmedCount ? summary.estimatedRevenue : verifiedAmount(lead);
      const recovered = Boolean(lead.recovered || customerLifecycleStatus === "recovered" || summary.completed || actualRevenue > 0);

      return res.status(200).json({
        success: true,
        data: {
          pagination: Object.fromEntries(Object.entries(pages).map(([key, page]) => [key, page.pagination])),
          historyOrder: "newest_first; messages chronological within each page",
          customer: {
            ...lead,
            customerLifecycleStatus,
          },
          conversation: summary.conversation ? withLifecycle([summary.conversation])[0] : canonicalConversations[0] || null,
          conversations: canonicalConversations,
          messages,
          calls,
          appointment: currentAppointment,
          appointments: canonicalAppointments,
          voiceSessions: canonicalVoiceSessions,
          intervention: activeIntervention,
          interventions: canonicalInterventions,
          aiSummary:
            latestIntelligence?.summary ||
            lead.summary ||
            summary.conversation?.conversationMemory?.summary ||
            "",
          intelligence: latestIntelligence,
          recovery: {
            recovered,
            recoveredBy: lead.recoveredBy || null,
            estimatedRevenue,
            actualRevenue,
            conversionEvents,
          },
          actions: {
            canCall: Boolean(lead.phone),
            canText: Boolean(
              lead.phone &&
                business.phone &&
                business.trackingNumber?.status === "active",
            ),
            customerPhone: lead.phone || "",
            conversationId: asId(summary.conversation || conversations[0]) || "",
          },
        },
      });
    } catch (error) {
      if (error.statusCode === 400) return res.status(400).json({ success: false, message: error.message });
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "Customer history is busy. Please retry." });
      safeConsole.error("Customer recovery detail error:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to load customer recovery details.",
      });
    }
  }
}

export default CustomerRecoveryController;
