import { recordCallAnswer } from "../services/callAnswerEvidence.service.js";
import Alert from "../models/alert.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import Message from "../models/message.js";
import VoiceSession from "../models/voiceSession.js";
import { sendSms } from "../services/twilioSmsService.js";
import { isSmsSuppressed } from "../services/messaging/contactPreference.service.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";
import SocketService from "../services/socket.service.js";
import VoiceLineTypeService from "./voiceLineType.service.js";
import {
  isUsableCallerId,
  normalizePhoneToE164,
} from "./voicePhone.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";
import { resolveTrackingNumberContext, syncLatestAttribution } from "../services/marketingAttribution.service.js"; // CALLBACKIQ_ATTRIBUTION_PRODUCTION_HARDENING

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const TRANSITIONS = Object.freeze({
  routing: new Set(["connecting", "active", "fallback_sms", "failed", "canceled"]),
  connecting: new Set(["active", "fallback_sms", "failed", "canceled"]),
  active: new Set([
    "capturing_callback",
    "safety_escalated",
    "transferring",
    "completing",
    "fallback_sms",
    "failed",
    "canceled",
  ]),
  capturing_callback: new Set([
    "active",
    "safety_escalated",
    "completing",
    "fallback_sms",
    "failed",
    "canceled",
  ]),
  safety_escalated: new Set(["completing", "fallback_sms", "failed"]),
  transferring: new Set(["completing", "fallback_sms", "failed"]),
  completing: new Set(["completed", "fallback_sms", "failed"]),
  fallback_sms: new Set(["failed"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
});

const emit = (method, ...args) => {
  try {
    if (typeof SocketService?.[method] === "function") {
      SocketService[method](...args);
    }
  } catch (error) {
    logOperationalWarning("voice.socket_event_failed", {
      method,
      errorCode: error?.code || error?.name || "error",
    });
  }
};

const normalizeId = (value) => value?._id || value?.id || value || null;
const populateSession = (query) =>
  query.populate(["business", "lead", "conversation", "callLog", "appointment"]);
const anonymousContact = () => "+00000000000";
const sanitizeMetadata = (metadata = {}) => {
  const set = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (!key || key.includes("$") || key.includes("\0")) continue;
    set[`metadata.${key}`] = value;
  }
  return set;
};

class VoiceSessionService {
  static async findContext({ business, businessId, providerCallSid }) {
    const scopedBusinessId = normalizeId(business) || businessId;
    if (!scopedBusinessId || !providerCallSid) return null;
    return populateSession(
      VoiceSession.findOne({
        business: scopedBusinessId,
        providerCallSid,
      }),
    );
  }

  static async ensureContext({ business, from, to, providerCallSid }) {
    if (!business?._id || !providerCallSid) {
      throw new Error("Voice session context requires a business and CallSid.");
    }

    const normalizedFrom = normalizePhoneToE164(from);
    const normalizedTo = normalizePhoneToE164(to) || String(to || "").trim();
    const numberContext = await resolveTrackingNumberContext(normalizedTo);
    const usableCaller = isUsableCallerId(normalizedFrom);
    const storedCaller = usableCaller ? normalizedFrom : anonymousContact();

    let session;
    try {
      session = await VoiceSession.findOneAndUpdate(
        { business: business._id, providerCallSid },
        {
          $setOnInsert: {
            business: business._id,
            providerCallSid,
            from: storedCaller,
            to: normalizedTo,
            status: "routing",
            startedAt: new Date(),
          },
          // Do not write the metadata parent in $setOnInsert while also writing
          // metadata.* children in $set. MongoDB rejects that as a conflicting
          // update path, which prevented new voice sessions from being created.
          $set: {
            lastActivityAt: new Date(),
            "metadata.callerIdUsable": usableCaller,
            "metadata.originalCallerIdClassification": usableCaller
              ? "usable"
              : "anonymous_or_restricted",
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      session = await VoiceSession.findOne({
        business: business._id,
        providerCallSid,
      });
    }
    if (!session) throw new Error("Voice session context could not be created.");

    if (session.lead && session.conversation && session.callLog) {
      return populateSession(VoiceSession.findById(session._id));
    }

    /*
     * Lead, conversation, and call-log discovery are independent once the
     * VoiceSession exists. Resolve them concurrently to avoid serial Atlas
     * round trips. Creation remains ordered below because Conversation depends
     * on Lead and CallLog depends on both.
     */
    const leadLookup = session.lead
      ? Lead.findById(session.lead)
      : usableCaller
        ? Lead.findOne({
            business: business._id,
            phone: normalizedFrom,
          }).sort({ createdAt: -1 })
        : Promise.resolve(null);

    const conversationLookup = session.conversation
      ? Conversation.findById(session.conversation)
      : usableCaller
        ? Conversation.findOne({
            business: business._id,
            customerPhone: normalizedFrom,
            status: "open",
          }).sort({ lastMessageAt: -1 })
        : Promise.resolve(null);

    const callLogLookup = session.callLog
      ? CallLog.findById(session.callLog)
      : CallLog.findOne({
          business: business._id,
          providerCallId: providerCallSid,
        });

    let [lead, conversation, callLog] = await Promise.all([
      leadLookup,
      conversationLookup,
      callLogLookup,
    ]);
    if (!lead) {
      try {
        lead = await Lead.create({
          business: business._id,
          customerName: usableCaller ? "Voice Caller" : "Anonymous Voice Caller",
          phone: storedCaller,
          serviceNeeded: "Unknown",
          urgency: "medium",
          source: "voice",
          status: "new",
          estimatedValue: null,
          valuation: { source: "unknown", basis: "Not estimated" },
          valuationVersion: 0,
          notes: usableCaller
            ? "Lead created automatically from a CallBackIQ voice session."
            : "Lead created from a blocked or unavailable caller ID. Obtain and confirm a callback number before promising follow-up.",
        });
        emit("emitLeadCreated", business._id, lead);
      } catch (error) {
        // Two first-time calls from the same caller can both observe no Lead.
        // The unique business+phoneLookup index is authoritative; the loser of
        // that race must attach to the Lead that won instead of failing a call.
        if (error?.code !== 11000 || !usableCaller) throw error;
        lead = await Lead.findOne({
          business: business._id,
          phone: normalizedFrom,
        }).sort({ createdAt: -1 });
        if (!lead) throw error;
      }
    }

    if (!conversation) {
      try {
        conversation = await Conversation.create({
          business: business._id,
          lead: lead._id,
          customerPhone: storedCaller,
          customerName: lead.customerName || "Voice Caller",
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
          lastMessage: "Voice session started.",
          lastMessageAt: new Date(),
          replyFromPhone: normalizedTo || business.phone,
        });
        emit("emitConversationCreated", business._id, conversation);
      } catch (error) {
        // Same-caller concurrent calls can also race on the unique active
        // conversation identity. Reuse the open conversation that won.
        if (error?.code !== 11000 || !usableCaller) throw error;
        conversation = await Conversation.findOne({
          business: business._id,
          customerPhone: normalizedFrom,
          status: "open",
        }).sort({ lastMessageAt: -1 });
        if (!conversation) throw error;
      }
    }

    if (!callLog) {
      try {
        callLog = await CallLog.create({
          business: business._id,
          lead: lead._id,
          conversation: conversation._id,
          from: storedCaller,
          to: normalizedTo || business.phone,
          direction: "inbound",
          status: "missed",
          disposition: "routing",
          providerStatus: "ringing",
          durationSeconds: 0,
          provider: "twilio",
          providerCallId: providerCallSid,
          marketingSource: numberContext?.marketingSource?._id || null,
          trackingNumber: numberContext?.trackingNumber?._id || null,
          attribution: numberContext?.attribution || {},
          missedCallTextSent: false,
          recovered: false,
          notes: usableCaller
            ? "Call routed through CallBackIQ ConversationRelay."
            : "Call routed through ConversationRelay with anonymous or restricted caller ID.",
        });
        emit("emitCallCreated", business._id, callLog);
      } catch (error) {
        if (error?.code !== 11000) throw error;
        callLog = await CallLog.findOne({
          business: business._id,
          providerCallId: providerCallSid,
        });
      }
    }

    if (numberContext?.marketingSource && numberContext?.trackingNumber) {
      await syncLatestAttribution({
      callLogId: callLog?._id || null,
        businessId: business._id,
        leadId: lead._id,
        conversationId: conversation._id,
        trackingNumber: numberContext.trackingNumber,
        marketingSource: numberContext.marketingSource,
        calledPhone: normalizedTo,
      });
    }

    const updated = await VoiceSession.findByIdAndUpdate(
      session._id,
      {
        $set: {
          lead: lead._id,
          conversation: conversation._id,
          callLog: callLog?._id || null,
          estimatedValue: lead.estimatedValue ?? null,
          valuation: lead.valuation,
          lastActivityAt: new Date(),
          "metadata.callerIdUsable": usableCaller,
        },
      },
      { returnDocument: "after" },
    );
    return populateSession(VoiceSession.findById(updated._id));
  }

  static async transition(sessionId, nextStatus, metadata = {}) {
    if (!sessionId || !TRANSITIONS[nextStatus]) {
      throw new Error(`Unsupported voice-session status: ${nextStatus}`);
    }
    const current = await VoiceSession.findById(sessionId).select("status");
    if (!current) throw new Error("Voice session was not found.");
    if (current.status === nextStatus) {
      return VoiceSession.findByIdAndUpdate(
        sessionId,
        { $set: { lastActivityAt: new Date(), ...sanitizeMetadata(metadata) } },
        { returnDocument: "after" },
      );
    }
    if (!TRANSITIONS[current.status]?.has(nextStatus)) {
      const error = new Error(
        `Illegal voice-session transition from ${current.status} to ${nextStatus}.`,
      );
      error.code = "VOICE_SESSION_ILLEGAL_TRANSITION";
      throw error;
    }
    return VoiceSession.findOneAndUpdate(
      { _id: sessionId, status: current.status },
      {
        $set: {
          status: nextStatus,
          lastActivityAt: new Date(),
          ...sanitizeMetadata(metadata),
        },
      },
      { returnDocument: "after" },
    );
  }

  static async activateFromSetup({ voiceSessionId, setup }) {
    const session = await populateSession(VoiceSession.findById(voiceSessionId));
    if (!session) throw new Error("Voice session was not found.");
    if (session.providerCallSid !== setup.callSid) {
      throw new Error("ConversationRelay CallSid did not match the voice session.");
    }
    if (
      setup.customParameters?.businessId &&
      String(session.business?._id || session.business) !==
        String(setup.customParameters.businessId)
    ) {
      throw new Error("ConversationRelay business scope did not match.");
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      const error = new Error(
        `ConversationRelay cannot activate a terminal ${session.status} session.`,
      );
      error.code = "VOICE_SESSION_TERMINAL";
      throw error;
    }
    if (
      session.providerSessionId &&
      setup.sessionId &&
      session.providerSessionId !== setup.sessionId
    ) {
      const error = new Error("ConversationRelay SessionId changed unexpectedly.");
      error.code = "VOICE_SESSION_ID_MISMATCH";
      throw error;
    }

    const nextStatus = ["routing", "connecting"].includes(session.status)
      ? "active"
      : session.status;
    const from = normalizePhoneToE164(setup.from);
    const to = normalizePhoneToE164(setup.to);
    const update = {
      providerSessionId: setup.sessionId || session.providerSessionId,
      signatureValidated: true,
      status: nextStatus,
      lastActivityAt: new Date(),
      "metadata.accountSid": String(setup.accountSid || "").slice(0, 80),
      "metadata.callType": String(setup.callType || "").slice(0, 80),
      "metadata.direction": String(setup.direction || "").slice(0, 80),
      "metadata.setupReceivedAt": new Date().toISOString(),
    };
    if (from) update.from = from;
    if (to) update.to = to;

    await recordCallAnswer({ businessId: session.business?._id || session.business,
      callLogId: session.callLog?._id || session.callLog, answeredBy: 'ai' });
    return VoiceSession.findByIdAndUpdate(
      session._id,
      { $set: update },
      { returnDocument: "after" },
    ).populate(["business", "lead", "conversation", "callLog", "appointment"]);
  }

  static async touchActivity(sessionId, metadata = {}) {
    if (!sessionId) return null;
    return VoiceSession.findOneAndUpdate(
      { _id: sessionId, status: { $nin: [...TERMINAL_STATUSES] } },
      {
        $set: {
          lastActivityAt: new Date(),
          ...sanitizeMetadata(metadata),
        },
      },
      { returnDocument: "after" },
    );
  }

  static async markCompleted(sessionId, metadata = {}) {
    const session = await VoiceSession.findById(sessionId);
    if (!session) return null;
    if (session.status === "completed") return populateSession(VoiceSession.findById(sessionId));
    if (TERMINAL_STATUSES.has(session.status)) return null;

    await VoiceSession.findOneAndUpdate(
      { _id: sessionId, status: { $nin: [...TERMINAL_STATUSES] } },
      {
        $set: {
          status: "completing",
          lastActivityAt: new Date(),
          ...sanitizeMetadata(metadata),
        },
      },
    );
    await VoiceTranscriptService.finalize(sessionId);
    const completed = await VoiceSession.findOneAndUpdate(
      { _id: sessionId, status: "completing" },
      {
        $set: {
          status: "completed",
          endedAt: new Date(),
          lastActivityAt: new Date(),
          ...sanitizeMetadata(metadata),
        },
      },
      { returnDocument: "after" },
    );
    if (!completed) return null;
    emit("emitDashboardRefresh", completed.business, "voice_session_completed");
    return completed;
  }

  static async sendFallbackSms({ sessionId, failureReason, alert = true }) {
    const claimed = await VoiceSession.findOneAndUpdate(
      {
        _id: sessionId,
        fallbackSmsStatus: { $in: ["pending", "failed"] },
        status: { $nin: ["completed", "canceled"] },
      },
      {
        $set: {
          fallbackSmsStatus: "sending",
          failureReason: String(failureReason || "Voice AI unavailable").slice(
            0,
            2000,
          ),
          status: "fallback_sms",
          endedAt: new Date(),
          lastActivityAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) return populateSession(VoiceSession.findById(sessionId));

    const session = await populateSession(VoiceSession.findById(sessionId));
    if (!session?.business) {
      throw new Error("Voice fallback could not resolve the business context.");
    }
    const business = session.business;
    const lead = session.lead;
    const conversation = session.conversation;
    const callLog = session.callLog;
    const from = normalizePhoneToE164(session.to || business.phone);
    const to = normalizePhoneToE164(session.from || lead?.phone);
    const body = String(
      business.smsTemplate ||
        `Hi, this is ${business.businessName}. Sorry we missed your call. What service do you need help with today?`,
    ).replaceAll("{{businessName}}", business.businessName);

    let suppressionReason = "";
    if (business.features?.missedCallSmsEnabled === false) {
      suppressionReason = "The business disabled missed-call SMS.";
    } else if (!isUsableCallerId(to) || !from) {
      suppressionReason = "A usable caller or business phone number was unavailable.";
    } else {
      const line = await VoiceLineTypeService.lookup(to);
      if (line.landline) {
        suppressionReason = `The callback number was classified as ${line.lineType}, so no SMS was promised or sent.`;
      } else if (
        await isSmsSuppressed({ businessId: business._id, phone: to })
      ) {
        suppressionReason = "The caller opted out of SMS.";
      }
    }

    let providerMessageId = "";
    if (suppressionReason) {
      await VoiceSession.findByIdAndUpdate(session._id, {
        $set: {
          fallbackSmsStatus: "suppressed",
          status: "failed",
          "metadata.fallbackSmsSuppressionReason": suppressionReason,
        },
      });
    } else {
      try {
        const sent = await sendSms({
          business,
          businessId: business._id,
          from,
          to,
          body,
          actorType: "voice",
          source: "voice_fallback",
          usageCategory: "voice_fallback",
          conversationId: conversation?._id || null,
          leadId: lead?._id || null,
          metadata: { voiceSessionId: session._id },
        });
        if (sent?.suppressed) {
          suppressionReason = sent.reason || "Central SMS policy suppressed the message.";
          await VoiceSession.findByIdAndUpdate(session._id, {
            $set: {
              fallbackSmsStatus: "suppressed",
              status: "failed",
              "metadata.fallbackSmsSuppressionReason": suppressionReason,
            },
          });
        } else {
          providerMessageId = sent?.sid || "";
          await VoiceSession.findByIdAndUpdate(session._id, {
            $set: {
              fallbackSmsStatus: "sent",
              fallbackSmsSentAt: new Date(),
              fallbackSmsProviderMessageId: providerMessageId,
              status: "failed",
            },
          });
          if (conversation) {
            try {
              const message = await Message.create({
                business: business._id,
                conversation: conversation._id,
                lead: lead?._id || null,
                direction: "outbound",
                from,
                to,
                body,
                provider: "twilio",
                providerMessageId,
                status: sent?.status || "sent",
                isAiGenerated: false,
                generatedBy: "voice",
                usageCategory: "voice_fallback",
                actorType: "voice",
                metadata: { source: "voice_fallback", voiceSessionId: session._id },
              });
              emit("emitMessageCreated", business._id, message);
              conversation.lastMessage = body;
              conversation.lastMessageAt = new Date();
              await conversation.save();
              emit("emitConversationUpdated", business._id, conversation);
            } catch (error) {
              logOperationalError(
                "voice.fallback_sms_local_persistence_failed",
                error,
                { businessId: business._id, voiceSessionId: session._id, providerMessageId },
              );
            }
          }
        }
      } catch (error) {
        await VoiceSession.findByIdAndUpdate(session._id, {
          $set: {
            fallbackSmsStatus: "failed",
            fallbackSmsProviderMessageId: "",
            status: "failed",
            failureReason: `${failureReason || "Voice AI unavailable"}; SMS fallback failed: ${error.message}`.slice(
              0,
              2000,
            ),
          },
        });
        logOperationalError("voice.fallback_sms_failed", error, {
          businessId: business._id,
          voiceSessionId: session._id,
        });
      }
    }

    if (callLog) {
      callLog.status = "failed";
      callLog.missedCallTextSent = Boolean(providerMessageId);
      await callLog.save();
      emit("emitCallUpdated", business._id, callLog);
    }

    if (alert) {
      const failureAlert = await Alert.findOneAndUpdate(
        { business: business._id, dedupeKey: `voice_failure:${session._id}` },
        {
          $setOnInsert: {
            business: business._id,
            lead: lead?._id || null,
            conversation: conversation?._id || null,
            type: "integration_failure",
            channel: "in_app",
            title: "Voice AI session failed",
            message: suppressionReason
              ? `The voice session failed. The transcript was preserved, but SMS fallback was suppressed: ${suppressionReason}`
              : "The voice session failed. The transcript was preserved and the missed-call SMS fallback was attempted.",
            status: "pending",
            priority: "high",
            actionRequired: true,
            reason: String(failureReason || "Voice AI unavailable").slice(0, 1000),
            recommendedAction:
              "Review the partial transcript and contact the caller directly. For anonymous callers, review the call path because no callback number may be available.",
            lastCustomerMessage:
              session.transcript
                ?.filter((entry) => entry.role === "customer")
                .at(-1)?.text || "",
            dedupeKey: `voice_failure:${session._id}`,
            metadata: {
              voiceSessionId: session._id,
              providerCallSid: session.providerCallSid,
              fallbackSmsStatus: providerMessageId
                ? "sent"
                : suppressionReason
                  ? "suppressed"
                  : "failed",
            },
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (failureAlert) emit("emitAlertCreated", business._id, failureAlert);
    }

    emit("emitDashboardRefresh", business._id, "voice_session_failed");
    return populateSession(VoiceSession.findById(sessionId));
  }
}

export { TERMINAL_STATUSES, TRANSITIONS };
export default VoiceSessionService;
