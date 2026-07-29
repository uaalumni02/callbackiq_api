import Alert from "../models/alert.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import Message from "../models/message.js";
import VoiceSession from "../models/voiceSession.js";
import { sendSms } from "../services/twilioSmsService.js";
import { isSmsSuppressed } from "../services/messaging/contactPreference.service.js";
import SocketService from "../services/socket.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";

const emit = (method, ...args) => {
  try {
    if (typeof SocketService?.[method] === "function") {
      SocketService[method](...args);
    }
  } catch (error) {
    console.warn(`Voice socket event ${method} failed:`, error.message);
  }
};

const populateSession = (query) =>
  query.populate(["business", "lead", "conversation", "callLog", "appointment"]);

class VoiceSessionService {
  static async ensureContext({ business, from, to, providerCallSid }) {
    let session;
    try {
      session = await VoiceSession.findOneAndUpdate(
        { business: business._id, providerCallSid },
        {
          $setOnInsert: {
            business: business._id,
            providerCallSid,
            from,
            to,
            status: "routing",
            startedAt: new Date(),
            lastActivityAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      session = await VoiceSession.findOne({
        business: business._id,
        providerCallSid,
      });
    }
    if (!session) {
      throw new Error("Voice session context could not be created.");
    }

    let lead = session.lead
      ? await Lead.findById(session.lead)
      : await Lead.findOne({ business: business._id, phone: from }).sort({
          createdAt: -1,
        });
    if (!lead) {
      lead = await Lead.create({
        business: business._id,
        customerName: "Voice Caller",
        phone: from,
        serviceNeeded: "Unknown",
        urgency: "medium",
        source: "voice",
        status: "new",
        estimatedValue: business.estimatedJobValue || 0,
        notes: "Lead created automatically from a CallBackIQ voice session.",
      });
      emit("emitLeadCreated", business._id, lead);
    }

    let conversation = session.conversation
      ? await Conversation.findById(session.conversation)
      : await Conversation.findOne({
          business: business._id,
          customerPhone: from,
          status: "open",
        }).sort({ lastMessageAt: -1 });
    if (!conversation) {
      conversation = await Conversation.create({
        business: business._id,
        lead: lead._id,
        customerPhone: from,
        customerName: lead.customerName || "Voice Caller",
        status: "open",
        aiEnabled: true,
        humanTakeover: false,
        lastMessage: "Voice session started.",
        lastMessageAt: new Date(),
      });
      emit("emitConversationCreated", business._id, conversation);
    }

    let callLog = session.callLog
      ? await CallLog.findById(session.callLog)
      : await CallLog.findOne({
          business: business._id,
          providerCallId: providerCallSid,
        });
    if (!callLog) {
      callLog = await CallLog.create({
        business: business._id,
        lead: lead._id,
        conversation: conversation._id,
        from,
        to,
        direction: "inbound",
        status: "answered",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: providerCallSid,
        missedCallTextSent: false,
        recovered: false,
        notes: "Call routed through CallBackIQ ConversationRelay.",
      });
      emit("emitCallCreated", business._id, callLog);
    }

    session.lead = lead._id;
    session.conversation = conversation._id;
    session.callLog = callLog._id;
    session.estimatedValue = lead.estimatedValue || 0;
    session.lastActivityAt = new Date();
    await session.save();

    return populateSession(VoiceSession.findById(session._id));
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

    session.providerSessionId = setup.sessionId || session.providerSessionId;
    session.signatureValidated = true;
    session.status = "active";
    session.from = setup.from || session.from;
    session.to = setup.to || session.to;
    session.lastActivityAt = new Date();
    session.metadata = {
      ...(session.metadata || {}),
      accountSid: setup.accountSid || "",
      callType: setup.callType || "",
      direction: setup.direction || "",
    };
    await session.save();
    return session;
  }

  static async markCompleted(sessionId, metadata = {}) {
    const session = await VoiceSession.findOneAndUpdate(
      {
        _id: sessionId,
        status: { $ne: "failed" },
      },
      {
        $set: {
          status: "completed",
          endedAt: new Date(),
          lastActivityAt: new Date(),
          metadata,
        },
      },
      { returnDocument: "after" },
    );
    if (!session) return null;
    await VoiceTranscriptService.finalize(sessionId);
    emit("emitDashboardRefresh", session.business, "voice_session_completed");
    return session;
  }

  static async sendFallbackSms({ sessionId, failureReason, alert = true }) {
    const claimed = await VoiceSession.findOneAndUpdate(
      {
        _id: sessionId,
        fallbackSmsStatus: { $in: ["pending", "failed"] },
      },
      {
        $set: {
          fallbackSmsStatus: "sending",
          failureReason: String(failureReason || "Voice AI unavailable").slice(
            0,
            2000,
          ),
          status: "failed",
          endedAt: new Date(),
          lastActivityAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      return populateSession(VoiceSession.findById(sessionId));
    }

    const session = await populateSession(VoiceSession.findById(sessionId));
    if (!session?.business) {
      throw new Error("Voice fallback could not resolve the business context.");
    }

    const business = session.business;
    const lead = session.lead;
    const conversation = session.conversation;
    const callLog = session.callLog;
    const from = session.to || business.phone;
    const to = session.from;
    const body = String(
      business.smsTemplate ||
        `Hi, this is ${business.businessName}. Sorry we missed your call. What service do you need help with today?`,
    ).replaceAll("{{businessName}}", business.businessName);

    let suppressionReason = "";
    if (business.features?.missedCallSmsEnabled === false) {
      suppressionReason = "The business disabled missed-call SMS.";
    } else if (!to || !from) {
      suppressionReason =
        "A valid caller or business phone number was unavailable.";
    } else {
      try {
        if (
          await isSmsSuppressed({
            businessId: business._id,
            phone: to,
          })
        ) {
          suppressionReason = "The caller opted out of SMS messages.";
        }
      } catch (error) {
        suppressionReason =
          "SMS preference status could not be verified, so delivery was suppressed.";
        console.error("Voice fallback SMS preference check failed:", error);
      }
    }

    if (suppressionReason) {
      await VoiceSession.findByIdAndUpdate(session._id, {
        $set: {
          fallbackSmsStatus: "suppressed",
          metadata: {
            ...(session.metadata || {}),
            fallbackSmsSuppressionReason: suppressionReason,
          },
        },
      });

      if (callLog) {
        callLog.status = "failed";
        callLog.missedCallTextSent = false;
        await callLog.save();
        emit("emitCallUpdated", business._id, callLog);
      }
    } else {
      let sent = null;
      try {
        sent = await sendSms({ to, from, body });
      } catch (error) {
        await VoiceSession.findByIdAndUpdate(session._id, {
          $set: {
            fallbackSmsStatus: "failed",
            fallbackSmsProviderMessageId: "",
            failureReason: `${failureReason || "Voice AI unavailable"}; SMS fallback failed: ${error.message}`.slice(
              0,
              2000,
            ),
          },
        });
      }

      if (sent) {
        const providerMessageId = sent?.sid || "";
        // Mark the provider delivery before local logging. If MongoDB logging
        // fails after Twilio accepted the message, a retry must not text the
        // caller a second time.
        await VoiceSession.findByIdAndUpdate(session._id, {
          $set: {
            fallbackSmsStatus: "sent",
            fallbackSmsSentAt: new Date(),
            fallbackSmsProviderMessageId: providerMessageId,
          },
        });

        try {
          const message = await Message.create({
            business: business._id,
            conversation: conversation?._id,
            lead: lead?._id,
            direction: "outbound",
            from,
            to,
            body,
            provider: "twilio",
            providerMessageId,
            status: "sent",
            isAiGenerated: false,
            metadata: { voiceSessionId: session._id },
          });
          emit("emitMessageCreated", business._id, message);

          if (conversation) {
            conversation.lastMessage = body;
            conversation.lastMessageAt = new Date();
            await conversation.save();
            emit("emitConversationUpdated", business._id, conversation);
          }
          if (callLog) {
            callLog.status = "failed";
            callLog.missedCallTextSent = true;
            await callLog.save();
            emit("emitCallUpdated", business._id, callLog);
          }
        } catch (error) {
          console.error(
            "Voice fallback SMS was sent but could not be fully logged:",
            error,
          );
          await VoiceSession.findByIdAndUpdate(session._id, {
            $set: {
              failureReason: `${failureReason || "Voice AI unavailable"}; fallback SMS was delivered but local persistence failed: ${error.message}`.slice(
                0,
                2000,
              ),
            },
          });
        }
      }
    }
    if (alert) {
      const failureAlert = await Alert.findOneAndUpdate(
        {
          business: business._id,
          dedupeKey: `voice_failure:${session._id}`,
        },
        {
          $setOnInsert: {
            business: business._id,
            lead: lead?._id || null,
            conversation: conversation?._id || null,
            type: "integration_failure",
            channel: "in_app",
            title: "Voice AI session failed",
            message: suppressionReason
              ? `The voice session failed. CallBackIQ preserved the transcript, but SMS fallback was suppressed: ${suppressionReason}`
              : "The voice session failed. CallBackIQ preserved the transcript and attempted the missed-call SMS fallback.",
            status: "pending",
            priority: "high",
            actionRequired: true,
            reason: String(failureReason || "Voice AI unavailable").slice(
              0,
              1000,
            ),
            recommendedAction:
              "Review the partial transcript and contact the caller directly.",
            lastCustomerMessage:
              session.transcript
                ?.filter((entry) => entry.role === "customer")
                .at(-1)?.text || "",
            dedupeKey: `voice_failure:${session._id}`,
            metadata: { voiceSessionId: session._id },
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (failureAlert) {
        emit("emitAlertCreated", business._id, failureAlert);
      }
    }

    await VoiceTranscriptService.finalize(session._id);
    emit("emitDashboardRefresh", business._id, "voice_session_failed");
    return populateSession(VoiceSession.findById(session._id));
  }
}

export default VoiceSessionService;
