import { createAwaitedInsertBatch } from './database/awaitedInsertBatch.js';
import { moneyAmount } from "./valuation/opportunityValue.js";
import CallLog from "../models/callLog.js";
import ConversionEvent from "../models/conversionEvent.js";
import Lead from "../models/lead.js";
import SocketService from "./socket.service.js";

const insertConversionEvent = createAwaitedInsertBatch(ConversionEvent);

class ConversionEventService {
  static async record({
    businessId,
    leadId = null,
    conversationId = null,
    appointmentId = null,
    callLogId = null,
    marketingSourceId = null,
    trackingNumberId = null,
    attribution = {},
    type,
    channel = "manual",
    source = "",
    estimatedValue = null,
    valuation = undefined,
    actualRevenue = 0,
    occurredAt = new Date(),
    idempotencyKey = null,
    metadata = {},
  }) {
    try {
      const event = await insertConversionEvent({
        business: businessId,
        lead: leadId,
        conversation: conversationId,
        appointment: appointmentId,
        callLog: callLogId,
        marketingSource: marketingSourceId,
        trackingNumber: trackingNumberId,
        attribution,
        type,
        channel,
        source,
        estimatedValue: moneyAmount(estimatedValue),
        valuation,
        actualRevenue: Number(actualRevenue || 0),
        occurredAt,
        idempotencyKey,
        metadata,
      });

      SocketService.emitToBusiness(businessId, "conversion-event:created", event);
      SocketService.emitDashboardRefresh(businessId, `conversion:${type}`);
      return event;
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        return ConversionEvent.findOne({ business: businessId, idempotencyKey });
      }
      throw error;
    }
  }

  static async markAppointmentBooked({ appointment, lead, channel, bookedBy }) {
    const recovered = lead?.source === "missed_call";
    const recoveredBy = recovered
      ? bookedBy === "ai"
        ? channel === "voice"
          ? "voice_ai"
          : "sms_ai"
        : bookedBy === "staff"
          ? "staff"
          : "manual"
      : null;

    if (lead) {
      await Lead.updateOne(
        { _id: lead._id, business: appointment.business, $or: [{ bookedAt: null }, { bookedAt: { $lte: appointment.confirmedAt || new Date() } }] },
        {
          $set: {
            status: "booked",
            appointment: appointment._id,
            bookedAt: appointment.confirmedAt || new Date(),
            recovered,
            recoveredBy,
            // CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2:
            // the booked service/appointment is the authoritative open value.

          },
        },
      );

      if (recovered) {
        await CallLog.updateMany(
          {
            business: appointment.business,
            lead: lead._id,
            status: { $in: ["missed", "voicemail", "failed", "busy", "no_answer"] },
          },
          { $set: { recovered: true } },
        );
      }
    }

    return this.record({
      businessId: appointment.business,
      leadId: appointment.lead,
      conversationId: appointment.conversation,
      appointmentId: appointment._id,
      marketingSourceId: appointment.marketingSource || null,
      trackingNumberId: appointment.trackingNumber || null,
      attribution: appointment.attribution || {},
      type: "appointment_booked",
      occurredAt: appointment.confirmedAt || new Date(),
      channel,
      source: recovered ? "missed_call_recovery" : "direct_booking",
      estimatedValue: appointment.estimatedValue,
      valuation: appointment.valuation,
      actualRevenue: appointment.actualRevenue,
      idempotencyKey: `appointment_booked:${appointment._id}`,
      metadata: { recovered, recoveredBy, provider: appointment.provider },
    });
  }
}

export default ConversionEventService;
