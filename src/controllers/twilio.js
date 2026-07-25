import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import CallLog from "../models/callLog.js";

import { generateAIReplyResult } from "../services/aiReplyService.js";
import { sendSms } from "../services/twilioSmsService.js";
import AlertService from "../services/alert.service.js";
import SocketService from "../services/socket.service.js";

import {
  evaluateDeterministicInboundGuardrails,
} from "../helpers/ai/aiGuardrails.js";
import {
  isBusinessFeatureEnabled,
} from "../helpers/businessFeatures.js";
import {
  buildTwilioEventIdentity,
  getTwilioStatusEventType,
} from "../helpers/twilioEventKey.js";
import {
  processInboundSmsCommand,
} from "../services/messaging/contactPreference.service.js";
import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
  failTwilioWebhookEvent,
} from "../services/webhooks/twilioWebhookEvent.service.js";

const VALID_URGENCIES = new Set(["low", "medium", "high", "emergency"]);

const getBusinessForWebhook = async (phone) => {
  return typeof Db.getBusinessByPhoneForWebhook === "function"
    ? Db.getBusinessByPhoneForWebhook(Business, phone)
    : Db.getBusinessByPhone(Business, phone);
};

const getBusinessFromWebhookPhones = async (phones = []) => {
  const uniquePhones = [
    ...new Set(
      phones
        .map((phone) => String(phone || "").trim())
        .filter(Boolean),
    ),
  ];

  for (const phone of uniquePhones) {
    const business = await getBusinessForWebhook(phone);

    if (business) {
      return business;
    }
  }

  return null;
};

const getMessagesForReply = async (conversationId) => {
  return typeof Db.getMessagesForAI === "function"
    ? Db.getMessagesForAI(Message, conversationId)
    : Db.getMessagesByConversation(Message, conversationId);
};

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const emptyTwiml = () => xml("<Response></Response>");

const normalizeTemplate = (template, business) => {
  const fallback = `Hi, this is ${business.businessName}. Sorry we missed your call. What service do you need help with today?`;

  const text = template || fallback;

  return text.replaceAll("{{businessName}}", business.businessName);
};

const sendXmlResponse = (
  res,
  {
    statusCode = 200,
    contentType = "text/xml",
    responseBody = emptyTwiml(),
  } = {},
) => {
  res.type(contentType);
  return res.status(statusCode).send(responseBody);
};

const sendCachedWebhookResponse = (res, event, fallbackBody = emptyTwiml()) => {
  return sendXmlResponse(res, {
    statusCode: event?.responseStatusCode || 200,
    contentType: event?.responseContentType || "text/xml",
    responseBody: event?.responseBody || fallbackBody,
  });
};

const saveOutboundMessage = async ({
  businessId,
  conversation,
  lead,
  from,
  to,
  body,
  sent,
}) => {
  if (!sent || sent.suppressed === true) {
    return null;
  }

  const outboundMessage = await Db.saveMessage(Message, {
    business: businessId,
    conversation: conversation._id,
    lead: lead?._id || null,
    direction: "outbound",
    from,
    to,
    body,
    provider: "twilio",
    providerMessageId: sent.sid || "",
    status: "sent",
  });

  SocketService.emitMessageCreated(businessId, outboundMessage);

  return outboundMessage;
};

const updateConversationLastMessage = async ({
  businessId,
  conversation,
  lastMessage,
}) => {
  const updatedConversation = await Db.updateConversation(
    Conversation,
    conversation._id,
    {
      lastMessage,
      lastMessageAt: new Date(),
    },
  );

  SocketService.emitConversationUpdated(businessId, updatedConversation);

  return updatedConversation;
};

const buildLeadUpdatesFromAIResult = (lead, result) => {
  const updates = {};

  const serviceNeeded = String(result?.serviceNeeded || "").trim();

  if (serviceNeeded && serviceNeeded !== "Unknown") {
    updates.serviceNeeded = serviceNeeded;
  }

  if (result?.messageCategory === "emergency") {
    updates.urgency = "emergency";
  } else if (VALID_URGENCIES.has(result?.urgency)) {
    updates.urgency = result.urgency;
  }

  const address = String(result?.address || "").trim();

  if (address) {
    updates.address = address;
  }

  const preferredAppointmentTime = String(
    result?.preferredAppointmentTime || "",
  ).trim();

  if (preferredAppointmentTime) {
    updates.preferredAppointmentTime = preferredAppointmentTime;
  }

  const leadQualityScore = Number(result?.leadQualityScore);

  if (Number.isFinite(leadQualityScore) && leadQualityScore > 0) {
    updates.leadQualityScore = Math.min(
      100,
      Math.max(Number(lead?.leadQualityScore) || 0, leadQualityScore),
    );
  }

  const estimatedValue = Number(result?.estimatedValue);

  if (Number.isFinite(estimatedValue) && estimatedValue > 0) {
    updates.estimatedValue = estimatedValue;
  }

  const summary = String(result?.summary || "").trim();

  if (summary) {
    updates.summary = summary;
  }

  return updates;
};

const resultRequiresHumanTakeover = (result) => {
  const riskFlags = Array.isArray(result?.riskFlags)
    ? result.riskFlags
    : [];

  return (
    ["emergency", "hazardous_diy_request", "human_requested"].includes(
      result?.messageCategory,
    ) ||
    riskFlags.includes("safety_hazard") ||
    riskFlags.includes("hazardous_diy_request")
  );
};

const applyAIResult = async ({
  businessId,
  lead,
  conversation,
  inboundMessage,
  providerMessageId,
  customerPhone,
  result,
}) => {
  let updatedLead = lead;
  let updatedConversation = conversation;

  const leadUpdates = buildLeadUpdatesFromAIResult(lead, result);

  if (Object.keys(leadUpdates).length > 0) {
    updatedLead = await Db.updateLead(Lead, lead._id, leadUpdates);
    SocketService.emitLeadUpdated(businessId, updatedLead);
  }

  if (resultRequiresHumanTakeover(result)) {
    updatedConversation = await Db.updateConversation(
      Conversation,
      conversation._id,
      {
        aiEnabled: false,
        humanTakeover: true,
      },
    );

    SocketService.emitConversationUpdated(
      businessId,
      updatedConversation,
    );
  }

  if (result?.shouldAlertOwner === true) {
    await AlertService.createAIReviewAlert({
      businessId,
      leadId: updatedLead._id,
      conversationId: updatedConversation._id,
      messageId: inboundMessage._id,
      providerMessageId,
      customerName: updatedLead.customerName,
      customerPhone,
      result,
    });
  }

  return {
    lead: updatedLead,
    conversation: updatedConversation,
  };
};

class TwilioController {
  static async voiceWebhook(req, res) {
    let webhookEvent = null;

    try {
      console.log("TWILIO VOICE BODY:", req.body);

      const customerPhone = req.body.From || req.body.Caller || "";
      const twilioNumber = req.body.To || req.body.Called || "";
      const callSid = req.body.CallSid || "";

      console.log("MISSED/FORWARDED CALL FROM:", customerPhone);
      console.log("TWILIO NUMBER:", twilioNumber);

      if (!customerPhone || !twilioNumber) {
        return sendXmlResponse(res);
      }

      const business = await getBusinessForWebhook(twilioNumber);

      console.log(
        "VOICE BUSINESS FOUND:",
        business?.businessName || "NO BUSINESS",
      );

      if (!business) {
        return sendXmlResponse(res);
      }

      const businessId = business._id;
      const eventIdentity = buildTwilioEventIdentity(
        "inbound_voice",
        req.body,
      );

      const claim = await claimTwilioWebhookEvent({
        businessId,
        ...eventIdentity,
        requestMetadata: {
          from: customerPhone,
          to: twilioNumber,
        },
      });

      if (!claim.claimed) {
        console.log("DUPLICATE TWILIO VOICE WEBHOOK:", eventIdentity.eventKey);
        return sendCachedWebhookResponse(res, claim.event);
      }

      webhookEvent = claim.event;

      const callLog = await Db.saveCallLog(CallLog, {
        business: businessId,
        from: customerPhone,
        to: twilioNumber,
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: callSid,
        missedCallTextSent: false,
        recovered: false,
        notes: "Missed call forwarded to CallBackIQ Twilio number.",
      });

      SocketService.emitCallCreated(businessId, callLog);

      let lead = await Db.getLeadByBusinessAndPhone(
        Lead,
        businessId,
        customerPhone,
      );

      if (!lead) {
        lead = await Db.saveLead(Lead, {
          business: businessId,
          customerName: "Missed Call Lead",
          phone: customerPhone,
          serviceNeeded: "Unknown",
          urgency: "medium",
          source: "missed_call",
          status: "new",
          estimatedValue: business.estimatedJobValue || 0,
          notes: "Lead created automatically from missed forwarded call.",
        });

        SocketService.emitLeadCreated(businessId, lead);
      }

      let conversation = await Db.getConversationByBusinessAndPhone(
        Conversation,
        businessId,
        customerPhone,
      );

      if (!conversation) {
        conversation = await Db.saveConversation(Conversation, {
          business: businessId,
          lead: lead._id,
          customerPhone,
          customerName: lead.customerName,
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
        });

        SocketService.emitConversationCreated(businessId, conversation);
      } else {
        conversation = await Db.updateConversation(
          Conversation,
          conversation._id,
          {
            lead: conversation.lead || lead._id,
          },
        );

        SocketService.emitConversationUpdated(businessId, conversation);
      }

      await AlertService.createMissedCallAlert({
        businessId,
        leadId: lead._id,
        customerName: lead.customerName,
        customerPhone,
        callLogId: callLog._id,
        providerCallId: callSid,
      });

      const starterText = normalizeTemplate(business.smsTemplate, business);
      const missedCallSmsEnabled = isBusinessFeatureEnabled(
        business,
        "missedCallSmsEnabled",
      );

      let missedCallTextSent = false;

      if (missedCallSmsEnabled) {
        const sent = await sendSms({
          to: customerPhone,
          from: twilioNumber,
          body: starterText,
          businessId,
        });

        if (sent?.suppressed === true) {
          console.log(
            "MISSED CALL SMS SUPPRESSED:",
            sent.reason || "customer_opted_out",
          );
        } else {
          console.log("MISSED CALL SMS SENT:", sent?.sid || "NO SID RETURNED");

          await saveOutboundMessage({
            businessId,
            conversation,
            lead,
            from: twilioNumber,
            to: customerPhone,
            body: starterText,
            sent,
          });

          conversation = await updateConversationLastMessage({
            businessId,
            conversation,
            lastMessage: starterText,
          });

          missedCallTextSent = true;
        }
      } else {
        console.log("MISSED CALL SMS DISABLED FOR BUSINESS:", businessId);
      }

      const updatedCallLog = await Db.updateCallLog(CallLog, callLog._id, {
        lead: lead._id,
        conversation: conversation._id,
        missedCallTextSent,
        recovered: false,
      });

      SocketService.emitCallUpdated(businessId, updatedCallLog);

      SocketService.emitDashboardRefresh(
        businessId,
        missedCallTextSent
          ? "missed_call_sms_sent"
          : "missed_call_recorded",
      );

      const responseBody = xml(`
<Response>
  <Say>Thank you. The business has been notified.</Say>
</Response>`);

      await completeTwilioWebhookEvent(webhookEvent._id, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });

      return sendXmlResponse(res, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });
    } catch (error) {
      console.error("Voice webhook error:", error);

      const responseBody = emptyTwiml();

      if (webhookEvent?._id) {
        await failTwilioWebhookEvent(webhookEvent._id, error, {
          statusCode: 200,
          contentType: "text/xml",
          responseBody,
        }).catch((eventError) => {
          console.error("Unable to mark voice webhook as failed:", eventError);
        });
      }

      return sendXmlResponse(res, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });
    }
  }

  static async statusWebhook(req, res) {
    let webhookEvent = null;

    try {
      console.log("TWILIO STATUS BODY:", req.body);

      const business = await getBusinessFromWebhookPhones([
        req.body.To,
        req.body.From,
        req.body.Called,
        req.body.Caller,
      ]);

      if (!business) {
        return sendXmlResponse(res);
      }

      const eventType = getTwilioStatusEventType(req.body);
      const eventIdentity = buildTwilioEventIdentity(eventType, req.body);

      const claim = await claimTwilioWebhookEvent({
        businessId: business._id,
        ...eventIdentity,
        requestMetadata: {
          status:
            req.body.CallStatus ||
            req.body.MessageStatus ||
            req.body.SmsStatus ||
            "",
        },
      });

      if (!claim.claimed) {
        console.log("DUPLICATE TWILIO STATUS WEBHOOK:", eventIdentity.eventKey);
        return sendCachedWebhookResponse(res, claim.event);
      }

      webhookEvent = claim.event;

      const responseBody = emptyTwiml();

      await completeTwilioWebhookEvent(webhookEvent._id, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });

      return sendXmlResponse(res, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });
    } catch (error) {
      console.error("Status webhook error:", error);

      const responseBody = emptyTwiml();

      if (webhookEvent?._id) {
        await failTwilioWebhookEvent(webhookEvent._id, error, {
          statusCode: 200,
          contentType: "text/xml",
          responseBody,
        }).catch((eventError) => {
          console.error("Unable to mark status webhook as failed:", eventError);
        });
      }

      return sendXmlResponse(res, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });
    }
  }

  static async handleInboundSms(req, res) {
    let webhookEvent = null;

    try {
      console.log("TWILIO SMS BODY:", req.body);

      const from = req.body.From;
      const to = req.body.To;
      const body = req.body.Body;
      const providerMessageId =
        req.body.MessageSid || req.body.SmsSid || "";

      if (!from || !to || !body) {
        return sendXmlResponse(res);
      }

      const business = await getBusinessForWebhook(to);

      console.log(
        "SMS BUSINESS FOUND:",
        business?.businessName || "NO BUSINESS",
      );

      if (!business) {
        return sendXmlResponse(res);
      }

      const businessId = business._id;
      const eventIdentity = buildTwilioEventIdentity(
        "inbound_sms",
        req.body,
      );

      const claim = await claimTwilioWebhookEvent({
        businessId,
        ...eventIdentity,
        requestMetadata: {
          from,
          to,
        },
      });

      if (!claim.claimed) {
        console.log("DUPLICATE TWILIO SMS WEBHOOK:", eventIdentity.eventKey);
        return sendCachedWebhookResponse(res, claim.event);
      }

      webhookEvent = claim.event;

      let lead = await Db.getLeadByBusinessAndPhone(Lead, businessId, from);

      if (!lead) {
        lead = await Db.saveLead(Lead, {
          business: businessId,
          customerName: "New SMS Lead",
          phone: from,
          serviceNeeded: "Unknown",
          source: "sms",
          status: "contacted",
          urgency: "medium",
          estimatedValue: business.estimatedJobValue || 0,
          notes: body,
        });

        SocketService.emitLeadCreated(businessId, lead);
      } else if (lead.status === "new") {
        lead = await Db.updateLead(Lead, lead._id, {
          status: "contacted",
          notes: body,
        });

        SocketService.emitLeadUpdated(businessId, lead);
      }

      let conversation = await Db.getConversationByBusinessAndPhone(
        Conversation,
        businessId,
        from,
      );

      if (!conversation) {
        conversation = await Db.saveConversation(Conversation, {
          business: businessId,
          lead: lead._id,
          customerPhone: from,
          customerName: lead.customerName,
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
          lastMessage: body,
          lastMessageAt: new Date(),
        });

        SocketService.emitConversationCreated(businessId, conversation);
      } else {
        conversation = await Db.updateConversation(
          Conversation,
          conversation._id,
          {
            lead: conversation.lead || lead._id,
            lastMessage: body,
            lastMessageAt: new Date(),
          },
        );

        SocketService.emitConversationUpdated(businessId, conversation);
      }

      const inboundMessage = await Db.saveMessage(Message, {
        business: businessId,
        conversation: conversation._id,
        lead: lead._id,
        direction: "inbound",
        from,
        to,
        body,
        provider: "twilio",
        providerMessageId,
        status: "received",
      });

      SocketService.emitMessageCreated(businessId, inboundMessage);

      const commandResult = await processInboundSmsCommand({
        businessId,
        phone: from,
        messageBody: body,
      });

      if (commandResult.handled) {
        if (commandResult.action === "opt_out") {
          conversation = await Db.updateConversation(
            Conversation,
            conversation._id,
            {
              aiEnabled: false,
              lastMessage: body,
              lastMessageAt: new Date(),
            },
          );

          SocketService.emitConversationUpdated(businessId, conversation);
        } else if (
          commandResult.action === "opt_in" &&
          conversation.humanTakeover !== true
        ) {
          conversation = await Db.updateConversation(
            Conversation,
            conversation._id,
            {
              aiEnabled: true,
              lastMessage: body,
              lastMessageAt: new Date(),
            },
          );

          SocketService.emitConversationUpdated(businessId, conversation);
        }

        if (commandResult.reply) {
          const sent = await sendSms({
            to: from,
            from: to,
            body: commandResult.reply,
            businessId,
            allowOptedOut: commandResult.allowOptedOutReply,
          });

          if (sent?.suppressed !== true) {
            await saveOutboundMessage({
              businessId,
              conversation,
              lead,
              from: to,
              to: from,
              body: commandResult.reply,
              sent,
            });

            conversation = await updateConversationLastMessage({
              businessId,
              conversation,
              lastMessage: commandResult.reply,
            });
          }
        }

        SocketService.emitDashboardRefresh(
          businessId,
          `sms_command_${commandResult.action}`,
        );

        const responseBody = emptyTwiml();

        await completeTwilioWebhookEvent(webhookEvent._id, {
          statusCode: 200,
          contentType: "text/xml",
          responseBody,
        });

        return sendXmlResponse(res, {
          statusCode: 200,
          contentType: "text/xml",
          responseBody,
        });
      }

      const messages = await getMessagesForReply(conversation._id);

      const deterministicAssessment =
        evaluateDeterministicInboundGuardrails({
          customerMessage: body,
          recentMessages: messages,
        });

      const aiQualificationEnabled = isBusinessFeatureEnabled(
        business,
        "aiQualificationEnabled",
      );

      const mayProcessAI =
        conversation.aiEnabled !== false &&
        conversation.humanTakeover !== true &&
        conversation.status !== "closed" &&
        (deterministicAssessment.handled || aiQualificationEnabled);

      let aiResult = null;

      if (mayProcessAI) {
        aiResult = await generateAIReplyResult({
          business,
          lead,
          messages,
          customerMessage: body,
        });

        const applied = await applyAIResult({
          businessId,
          lead,
          conversation,
          inboundMessage,
          providerMessageId,
          customerPhone: from,
          result: aiResult,
        });

        lead = applied.lead;
        conversation = applied.conversation;
      }

      await AlertService.createCustomerReplyAlert({
        businessId,
        leadId: lead._id,
        conversationId: conversation._id,
        messageId: inboundMessage._id,
        providerMessageId,
        customerName: lead.customerName,
        customerPhone: from,
        messageBody: body,
        priority:
          aiResult?.alertPriority === "critical"
            ? "critical"
            : conversation.humanTakeover === true ||
                ["high", "emergency"].includes(lead.urgency)
              ? "high"
              : "medium",
      });

      if (
        aiResult &&
        aiResult.decision !== "no_reply" &&
        String(aiResult.reply || "").trim()
      ) {
        const sent = await sendSms({
          to: from,
          from: to,
          body: aiResult.reply,
          businessId,
        });

        if (sent?.suppressed === true) {
          console.log(
            "AI SMS SUPPRESSED:",
            sent.reason || "customer_opted_out",
          );
        } else {
          console.log("AI SMS SENT:", sent?.sid || "NO SID RETURNED");

          await saveOutboundMessage({
            businessId,
            conversation,
            lead,
            from: to,
            to: from,
            body: aiResult.reply,
            sent,
          });

          conversation = await updateConversationLastMessage({
            businessId,
            conversation,
            lastMessage: aiResult.reply,
          });
        }
      }

      SocketService.emitDashboardRefresh(businessId, "inbound_sms_processed");

      const responseBody = emptyTwiml();

      await completeTwilioWebhookEvent(webhookEvent._id, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });

      return sendXmlResponse(res, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });
    } catch (error) {
      console.error("Inbound SMS error:", error);

      const responseBody = emptyTwiml();

      if (webhookEvent?._id) {
        await failTwilioWebhookEvent(webhookEvent._id, error, {
          statusCode: 200,
          contentType: "text/xml",
          responseBody,
        }).catch((eventError) => {
          console.error("Unable to mark SMS webhook as failed:", eventError);
        });
      }

      return sendXmlResponse(res, {
        statusCode: 200,
        contentType: "text/xml",
        responseBody,
      });
    }
  }

  static async sendManualSms(req, res) {
    try {
      const { to, from, body } = req.body;

      if (!to || !from || !body) {
        return res.status(400).json({
          success: false,
          message: "to, from, and body are required.",
        });
      }

      const sent = await sendSms({
        to,
        from,
        body,
      });

      return res.status(200).json({
        success: true,
        message: "SMS sent successfully.",
        data: sent,
      });
    } catch (error) {
      console.error("Manual SMS error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to send SMS.",
      });
    }
  }
}

export default TwilioController;
