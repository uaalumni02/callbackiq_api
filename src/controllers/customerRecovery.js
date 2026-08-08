import mongoose from "mongoose";

import Alert from "../models/alert.js";
import Appointment from "../models/appointment.js";
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import ConversationIntelligence from "../models/conversationIntelligence.js";
import ConversionEvent from "../models/conversionEvent.js";
import Lead from "../models/lead.js";
import Message from "../models/message.js";
import VoiceSession from "../models/voiceSession.js";
import { syncCustomerLifecycle } from "../services/customerLifecycle.service.js";

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

      const business = await Business.findOne({ owner: ownerId }).lean();
      if (!business) {
        return res.status(404).json({ success: false, message: "Business not found" });
      }

      const lead = await Lead.findOne({
        _id: leadId,
        business: business._id,
      }).lean();
      if (!lead) {
        return res.status(404).json({ success: false, message: "Customer not found" });
      }

      const conversations = await Conversation.find({
        business: business._id,
        $or: [{ lead: lead._id }, { customerPhone: lead.phone }],
      })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .lean();

      const conversationIds = conversations.map(asId).filter(Boolean);
      const linked = (extra = []) => ({
        business: business._id,
        $or: [
          { lead: lead._id },
          ...(conversationIds.length
            ? [{ conversation: { $in: conversationIds } }]
            : []),
          ...extra,
        ],
      });

      const [
        messages,
        calls,
        appointments,
        voiceSessions,
        interventions,
        intelligence,
        conversionEvents,
      ] = await Promise.all([
        Message.find(linked()).sort({ createdAt: 1 }).lean(),
        CallLog.find(
          linked([{ from: lead.phone }, { to: lead.phone }]),
        )
          .sort({ createdAt: -1 })
          .lean(),
        Appointment.find(linked())
          .populate("serviceOffering")
          .sort({ startAt: -1 })
          .lean(),
        VoiceSession.find(linked()).sort({ startedAt: -1 }).lean(),
        Alert.find(linked())
          .populate("assignedTo", "userName email")
          .sort({ createdAt: -1 })
          .lean(),
        ConversationIntelligence.find(linked())
          .sort({ updatedAt: -1 })
          .lean(),
        ConversionEvent.find({
          business: business._id,
          lead: lead._id,
        })
          .sort({ occurredAt: -1, createdAt: -1 })
          .lean(),
      ]);

      const customerLifecycleStatus = await syncCustomerLifecycle({
        businessId: business._id,
        lead,
        conversations,
        appointments,
        voiceSessions,
      });

      // Return one canonical lifecycle value across every customer-domain
      // record even before the asynchronous persistence updates are observed by
      // a subsequent read.
      const withLifecycle = (items = []) =>
        items.map((item) => ({ ...item, customerLifecycleStatus }));
      const canonicalConversations = withLifecycle(conversations);
      const canonicalAppointments = withLifecycle(appointments);
      const canonicalVoiceSessions = withLifecycle(voiceSessions);
      const canonicalInterventions = withLifecycle(interventions);

      const currentAppointment =
        canonicalAppointments.find((item) =>
          ["held", "confirmed", "rescheduled"].includes(item.status),
        ) ||
        canonicalAppointments[0] ||
        null;
      const activeIntervention =
        canonicalInterventions.find(
          (item) => !item.resolvedAt && item.actionRequired,
        ) ||
        canonicalInterventions.find((item) => !item.resolvedAt) ||
        null;
      const latestIntelligence = intelligence[0] || null;

      const actualRevenue = maxMoney(
        lead.actualRevenue,
        appointments.map((item) => item.actualRevenue),
        conversionEvents.map((item) => item.actualRevenue),
      );
      const estimatedRevenue = maxMoney(
        lead.estimatedValue,
        appointments.map((item) => item.estimatedValue),
        conversionEvents.map((item) => item.estimatedValue),
        latestIntelligence?.estimatedRevenue?.likely,
      );
      const recovered = Boolean(
        lead.recovered ||
          customerLifecycleStatus === "recovered" ||
          appointments.some((item) => item.status === "completed") ||
          actualRevenue > 0,
      );

      return res.status(200).json({
        success: true,
        data: {
          customer: {
            ...lead,
            customerLifecycleStatus,
          },
          conversation: canonicalConversations[0] || null,
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
            conversations[0]?.conversationMemory?.summary ||
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
            conversationId: asId(conversations[0]) || "",
          },
        },
      });
    } catch (error) {
      console.error("Customer recovery detail error:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to load customer recovery details.",
      });
    }
  }
}

export default CustomerRecoveryController;
