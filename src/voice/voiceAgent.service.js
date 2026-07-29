import Appointment from "../models/appointment.js";
import CallLog from "../models/callLog.js";
import ServiceOffering from "../models/serviceOffering.js";
import searchServicesTool from "../helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../helpers/ai/tools/validateServiceArea.tool.js";
import sendConfirmationSmsTool from "../helpers/ai/tools/sendConfirmationSms.tool.js";
import BookingStateMachineService from "../services/booking/bookingStateMachine.service.js";
import { assessInboundSafety } from "../services/safetyAssessmentService.js";
import VoiceAvailabilityService from "./voiceAvailability.service.js";
import VoiceHandoffService from "./voiceHandoff.service.js";

const HUMAN_REQUEST = /\b(human|person|representative|agent|staff|someone|operator|transfer me|talk to)\b/i;
const BUSINESS_HOURS = /\b(hours|open|close|closing|opening|when are you open)\b/i;
const SERVICE_AREA = /\b(serve|service area|come to|travel to|cover)\b.*\b\d{5}\b|\b\d{5}\b.*\b(serve|service area|cover)\b/i;
const DIAGNOSTIC_FEE = /\b(diagnostic|service call|trip)\b.{0,20}\b(fee|cost|charge)\b/i;
const COMPLAINT_OR_DISPUTE = /\b(complaint|dispute|refund|chargeback|lawsuit|lawyer|attorney|terrible service|angry)\b/i;
const WARRANTY = /\b(warranty|guarantee claim)\b/i;
const COMMERCIAL = /\b(commercial|industrial|property manager|apartment complex|multi[- ]family)\b/i;
const EXISTING_JOB = /\b(existing job|current job|technician already|appointment today|where is the tech|previous repair|came out already)\b/i;
const COMPLEX_PRICING = /\b(exact|final|binding|firm)\b.{0,25}\b(price|quote|cost)|\bfull replacement quote\b/i;
const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;

const toSpokenReply = (value) =>
  String(value || "")
    .replace(/\bReply YES\b/gi, "Say yes")
    .replace(/\bPlease reply\b/gi, "Please say")
    .replace(/\bPlease send\b/gi, "Please say")
    .replace(/\bYou can reply with\b/gi, "You can say")
    .replace(/\bReply with\b/gi, "Say")
    .replace(/\bReply here\b/gi, "Tell me")
    .replace(/\bsend another day\b/gi, "say another day")
    .replace(/\bby SMS\b/gi, "by text")
    .trim();

const transferResult = async ({ session, reason, prompt, priority, alertType }) => ({
  reply: prompt,
  handoff: await VoiceHandoffService.request({
    session,
    reason,
    priority,
    alertType,
    customerMessage: session.transcript
      ?.filter((entry) => entry.role === "customer")
      .at(-1)?.text,
  }),
});

class VoiceAgentService {
  static async handlePrompt({ session, customerMessage }) {
    const text = String(customerMessage || "").trim();
    const business = session.business;
    const lead = session.lead;
    const conversation = session.conversation;

    const recentMessages = (session.transcript || []).slice(-8).map((entry) => ({
      direction: entry.role === "customer" ? "inbound" : "outbound",
      body: entry.text,
      createdAt: entry.at,
    }));
    const safety = await assessInboundSafety({
      customerMessage: text,
      recentMessages,
    });
    if (safety?.isEmergency || safety?.shouldSendSafetyReply) {
      if (lead) {
        lead.urgency = "emergency";
        lead.notes = `${lead.notes || ""}\nVoice safety escalation: ${text}`.trim();
        await lead.save();
      }
      return transferResult({
        session,
        reason: `safety_emergency:${safety?.hazardType || "other"}`,
        priority: "critical",
        alertType: "safety_emergency",
        prompt:
          safety?.reply ||
          "If anyone is in immediate danger, please hang up and call 911 now. I’m also transferring this call for urgent human review.",
      });
    }

    if (HUMAN_REQUEST.test(text)) {
      return transferResult({
        session,
        reason: "customer_requested_human",
        prompt: "Absolutely. I’m transferring you to the team now.",
      });
    }

    if (COMPLAINT_OR_DISPUTE.test(text)) {
      return transferResult({
        session,
        reason: "complaint_or_dispute",
        alertType: "angry_customer",
        prompt:
          "I’m sorry you’re dealing with that. I’m transferring you to a person who can review the situation directly.",
      });
    }

    if (WARRANTY.test(text) || COMMERCIAL.test(text) || EXISTING_JOB.test(text)) {
      return transferResult({
        session,
        reason: WARRANTY.test(text)
          ? "warranty_claim"
          : COMMERCIAL.test(text)
            ? "commercial_request"
            : "existing_job_problem",
        prompt:
          "That request needs a team member to review the account and job details. I’m transferring you now.",
      });
    }

    if (COMPLEX_PRICING.test(text)) {
      return transferResult({
        session,
        reason: "complex_pricing",
        prompt:
          "I can’t provide a binding quote by phone. I’m transferring you so the team can review the scope directly.",
      });
    }

    if (BUSINESS_HOURS.test(text)) {
      return { reply: await VoiceAvailabilityService.describeBusinessHours(business) };
    }

    if (SERVICE_AREA.test(text)) {
      const postalCode = text.match(ZIP_PATTERN)?.[1];
      if (!postalCode) {
        return { reply: "What five-digit ZIP code should I check?" };
      }
      const area = await validateServiceAreaTool({
        businessId: business._id,
        postalCode,
      });
      return {
        reply: area.supported
          ? `Yes, ${postalCode} is inside the approved service area. Would you like to schedule a residential service visit?`
          : `That ZIP code is outside the approved automated service area. I’ll transfer you so the team can review it directly.`,
        ...(area.supported
          ? {}
          : {
              handoff: await VoiceHandoffService.request({
                session,
                reason: "unsupported_service_area",
                customerMessage: text,
              }),
            }),
      };
    }

    if (DIAGNOSTIC_FEE.test(text)) {
      const matches = await searchServicesTool({
        businessId: business._id,
        query: text,
      });
      const service = matches.length === 1
        ? await ServiceOffering.findOne({
            _id: matches[0].id,
            business: business._id,
            active: true,
          })
        : null;
      if (service?.discloseDiagnosticFee && Number.isFinite(service.diagnosticFee)) {
        return {
          reply: `The published diagnostic fee for ${service.name} is $${service.diagnosticFee}. Final scope and pricing still require technician evaluation.`,
        };
      }
      return {
        reply:
          "I don’t have a verified diagnostic fee for that service. I can help book a visit, or transfer you to the team for pricing details.",
      };
    }

    if (!business?.features?.aiBookingEnabled) {
      return transferResult({
        session,
        reason: "voice_booking_not_enabled",
        prompt:
          "Automated booking is not enabled for this business, so I’m transferring your request to the team.",
      });
    }

    const previousAppointmentId = conversation?.bookingState?.appointment;
    const booking = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: text,
      channel: "voice",
      source: "voice_booking_state_machine",
    });

    if (!booking.handled) {
      return transferResult({
        session,
        reason: "low_ai_confidence",
        alertType: "low_ai_confidence",
        prompt:
          "I want to make sure this is handled correctly. I’m transferring you to the team now.",
      });
    }

    const spokenBookingReply = toSpokenReply(booking.result?.reply);
    if (conversation.bookingState?.status === "failed") {
      return transferResult({
        session,
        reason: "voice_booking_failed",
        alertType: "booking_conflict",
        prompt:
          spokenBookingReply ||
          "I’m having trouble confirming that appointment. I’m transferring you to the team now.",
      });
    }
    if (
      booking.result?.messageCategory === "service_area_question" &&
      /outside/i.test(booking.result?.reply || "")
    ) {
      return transferResult({
        session,
        reason: "unsupported_service_area",
        prompt: spokenBookingReply,
      });
    }

    await conversation.populate("bookingState.appointment");
    const appointmentId = conversation.bookingState?.appointment;
    if (
      appointmentId &&
      String(appointmentId?._id || appointmentId) !== String(previousAppointmentId || "") &&
      conversation.bookingState?.status === "booked"
    ) {
      const appointment = await Appointment.findById(appointmentId);
      if (appointment?.status === "confirmed") {
        session.appointment = appointment._id;
        session.estimatedValue = appointment.estimatedValue || lead?.estimatedValue || 0;
        await session.save();

        if (lead) {
          lead.status = "booked";
          lead.bookedAt = lead.bookedAt || new Date();
          lead.appointment = appointment._id;
          lead.recovered = true;
          lead.recoveredBy = "voice_ai";
          await lead.save();
        }
        const callLog =
          session.callLog && typeof session.callLog.save === "function"
            ? session.callLog
            : session.callLog
              ? await CallLog.findById(session.callLog)
              : null;
        if (callLog) {
          callLog.recovered = true;
          await callLog.save();
        }

        try {
          await sendConfirmationSmsTool({
            business,
            lead,
            conversation,
            appointmentId: appointment._id,
            voiceSessionId: session._id,
          });
        } catch (error) {
          console.error("Voice booking confirmation SMS failed:", error);
        }
      }
    }

    return { reply: spokenBookingReply };
  }
}

export default VoiceAgentService;
