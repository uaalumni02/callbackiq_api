import { awaitedUpdateManyBatch } from "../database/awaitedUpdateManyBatch.js";
import { blocksServiceAutomation } from '../serviceEligibility/policy.js';
import {
  resetTwilioClient as resetCentralTwilioClient,
  sendSms,
} from "../twilioSmsService.js";

import Alert from "../../models/alert.js";
import Appointment from "../../models/appointment.js";
import AutomationJob from "../../models/automationJob.js";
import Business from "../../models/business.js";
import ContactPreference from "../../models/contactPreference.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import Message from "../../models/message.js";
import SocketService from "../socket.service.js";

// Twilio client creation and outbound policy enforcement are centralized.

const interpolate = (template, values) =>
  String(template || "").replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_, path) => {
    const value = path.split(".").reduce((current, key) => current?.[key], values);
    return value === undefined || value === null ? "" : String(value);
  });

const getLocalTimeParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
};

const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const timeToMinutes = (value) => {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return hour * 60 + minute;
};

const withinQuietHours = ({ now, timeZone, start, end }) => {
  const parts = getLocalTimeParts(now, timeZone);
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);

  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? current >= startMinutes && current < endMinutes
    : current >= startMinutes || current < endMinutes;
};

const getAutomationMessagingServiceSid = () =>
  String(process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();

const cancelIngressFollowUps = awaitedUpdateManyBatch(AutomationJob, "smsFollowUpCancellation");

class AutomationService {
  static async suppressionReason(job) {
    const businessId = job.business?._id || job.business;
    const conversationId = job.conversation?._id || job.conversation;
    const leadId = job.lead?._id || job.lead;
    const appointmentId = job.appointment?._id || job.appointment;
    const [business, conversation, lead, preference, confirmedAppointment, safetyAlert] =
      await Promise.all([
        Business.findById(businessId).lean(),
        conversationId ? Conversation.findById(conversationId).lean() : null,
        leadId ? Lead.findById(leadId).lean() : null,
        conversationId
          ? Conversation.findById(conversationId)
              .select("customerPhone")
              .lean()
              .then((item) =>
                item?.customerPhone
                  ? ContactPreference.findOne({
                      business: businessId,
                      phone: item.customerPhone,
                    }).lean()
                  : null,
              )
          : null,
        appointmentId
          ? Appointment.findOne({
              _id: appointmentId,
              business: businessId,
              status: "confirmed",
            }).lean()
          : null,
        Alert.findOne({
          business: businessId,
          conversation: conversationId,
          type: "safety_emergency",
          resolvedAt: null,
        }).lean(),
      ]);

    if (!business?.isActive) return "business_inactive";
    if (blocksServiceAutomation(conversation) && !confirmedAppointment) return "service_eligibility_required";
    if (!business.features?.automatedFollowUpEnabled) return "automation_disabled";
    if (!conversation || conversation.status !== "open") return "conversation_not_open";
    if (conversation.humanTakeover) return "human_takeover";
    if (conversation.orchestration?.handoffReason === "intake_complete") return "intake_awaiting_team";
    if (lead && ["booked", "lost", "spam"].includes(lead.status)) return `lead_${lead.status}`;
    if (preference?.smsStatus === "opted_out") return "customer_opted_out";
    if (confirmedAppointment) return "appointment_confirmed";
    if (safetyAlert) return "safety_condition";

    const failedDeliveries = await Message.countDocuments({
      business: businessId,
      conversation: conversationId,
      direction: "outbound",
      status: "failed",
    });
    if (failedDeliveries >= 2) return "repeated_delivery_failure";

    return null;
  }

  static async execute(job) {
    const populated = await AutomationJob.findById(job._id)
      .populate("workflow")
      .populate("business")
      .populate("conversation")
      .populate("lead")
      .populate("appointment");

    if (!populated || populated.status !== "processing") return null;
    const reason = await this.suppressionReason(populated);

    if (reason) {
      populated.status = "canceled";
      populated.canceledAt = new Date();
      populated.failureReason = reason;
      populated.lockedAt = null;
      populated.lockedBy = null;
      await populated.save();
      return populated;
    }

    const now = new Date();
    const timeZone = populated.business.timezone || "America/New_York";
    const timeParts = getLocalTimeParts(now, timeZone);
    const dayAllowed = (populated.workflow.allowedDays || []).includes(
      weekdayMap[timeParts.weekday],
    );
    const quiet = withinQuietHours({
      now,
      timeZone,
      start: populated.workflow.quietHoursStart,
      end: populated.workflow.quietHoursEnd,
    });

    if (!dayAllowed || quiet) {
      populated.status = "scheduled";
      populated.executeAt = new Date(now.getTime() + 60 * 60_000);
      populated.lockedAt = null;
      populated.lockedBy = null;
      await populated.save();
      return populated;
    }

    try {
      const values = {
        business: populated.business.toObject(),
        lead: populated.lead?.toObject?.() || populated.lead || {},
        conversation: populated.conversation.toObject(),
        appointment: populated.appointment?.toObject?.() || populated.appointment || {},
      };
      const body = interpolate(populated.template, values).trim();

      if (populated.action === "send_sms") {
        if (!body) throw new Error("Automation SMS template rendered an empty message.");
        const result = await sendSms({
          business: populated.business,
          businessId: populated.business._id,
          from: populated.business.phone,
          to: populated.conversation.customerPhone,
          body,
          actorType: "automation",
          source: "automation_workflow",
          usageCategory: "automation",
          conversationId: populated.conversation._id,
          leadId: populated.lead?._id || null,
          messagingServiceSid: getAutomationMessagingServiceSid(),
          metadata: {
            automationJobId: populated._id,
            workflowId: populated.workflow?._id || populated.workflow || null,
          },
        });

        if (result?.suppressed === true) {
          populated.status = result.policyBlocked ? "scheduled" : "canceled";
          populated.executeAt = result.policyBlocked
            ? new Date(Date.now() + 60 * 60_000)
            : populated.executeAt;
          populated.canceledAt = result.policyBlocked ? null : new Date();
          populated.failureReason =
            result.reason ||
            (result.policyBlocked
              ? "communication_usage_limit"
              : "customer_opted_out");
          populated.lockedAt = null;
          populated.lockedBy = null;
          await populated.save();
          return populated;
        }

        const message = await Message.create({
          business: populated.business._id,
          conversation: populated.conversation._id,
          lead: populated.lead?._id || null,
          direction: "outbound",
          from: populated.business.phone,
          to: populated.conversation.customerPhone,
          body,
          provider: "twilio",
          providerMessageId: result.sid,
          status: result.status || "queued",
          isAiGenerated: false,
          generatedBy: "automation",
          usageCategory: "automation",
          actorType: "automation",
          metadata: {
            source: "automation_workflow",
            automationJobId: populated._id,
            workflowId: populated.workflow?._id || populated.workflow || null,
          },
        });
        SocketService.emitMessageCreated(populated.business._id, message);
      } else if (populated.action === "create_alert" || populated.action === "mark_for_review") {
        const alert = await Alert.create({
          business: populated.business._id,
          lead: populated.lead?._id || null,
          conversation: populated.conversation._id,
          appointment: populated.appointment?._id || null,
          type: "unanswered_hot_lead",
          channel: "in_app",
          title: "Automated follow-up needs review",
          message: body || "This follow-up requires staff review.",
          status: "sent",
          priority: "medium",
          actionRequired: true,
          sentAt: new Date(),
        });
        SocketService.emitAlertCreated(populated.business._id, alert);
      }

      populated.status = "completed";
      populated.completedAt = new Date();
      populated.failureReason = "";
      populated.lockedAt = null;
      populated.lockedBy = null;
      await populated.save();
      return populated;
    } catch (error) {
      const maximumAttempts = Number(populated.workflow.maximumAttempts || 3);
      if (populated.attemptNumber < maximumAttempts) {
        populated.status = "scheduled";
        populated.attemptNumber += 1;
        populated.executeAt = new Date(
          Date.now() + Number(populated.workflow.minimumIntervalMinutes || 120) * 60_000,
        );
      } else {
        populated.status = "failed";
      }
      populated.failureReason = error.message;
      populated.lockedAt = null;
      populated.lockedBy = null;
      await populated.save();
      throw error;
    }
  }

  static async cancelObsolete({ businessId, leadId = null, conversationId = null, reason, batch = false }) {
    const filter = {
      business: businessId,
      status: { $in: ["scheduled", "processing"] },
      ...(leadId ? { lead: leadId } : {}),
      ...(conversationId ? { conversation: conversationId } : {}),
    };
    const update = {
      $set: {
        status: "canceled",
        canceledAt: new Date(),
        failureReason: reason,
        lockedAt: null,
        lockedBy: null,
      },
    };
    return batch ? cancelIngressFollowUps({ filter, update }) : AutomationJob.updateMany(filter, update);
  }

  static resetTwilioClient() {
    resetCentralTwilioClient();
  }
}

export default AutomationService;
