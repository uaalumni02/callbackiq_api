import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import CallLog from "../models/callLog.js";

import { generateAIReply } from "../services/aiReplyService.js";
import { sendSms } from "../services/twilioSmsService.js";
import AlertService from "../services/alert.service.js";
import SocketService from "../services/socket.service.js";

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const emptyTwiml = () => xml("<Response></Response>");

const normalizeTemplate = (template, business) => {
  const fallback = `Hi, this is ${business.businessName}. Sorry we missed your call. What service do you need help with today?`;

  const text = template || fallback;

  return text.replaceAll("{{businessName}}", business.businessName);
};

class TwilioController {
  static async voiceWebhook(req, res) {
    try {
      console.log("TWILIO VOICE BODY:", req.body);

      const customerPhone = req.body.From || req.body.Caller || "";
      const twilioNumber = req.body.To || req.body.Called || "";
      const callSid = req.body.CallSid || "";

      console.log("MISSED/FORWARDED CALL FROM:", customerPhone);
      console.log("TWILIO NUMBER:", twilioNumber);

      if (!customerPhone || !twilioNumber) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const business = await Db.getBusinessByPhoneForWebhook(
        Business,
        twilioNumber,
      );

      console.log(
        "VOICE BUSINESS FOUND:",
        business?.businessName || "NO BUSINESS",
      );

      if (!business) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const businessId = business._id;

      /*
       * Create the initial missed-call record.
       */
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

      /*
       * Find or create the lead.
       */
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

      /*
       * Find or create the conversation.
       */
      let conversation = await Db.getConversationByBusinessAndPhone(
        Conversation,
        businessId,
        customerPhone,
      );

      const starterText = normalizeTemplate(business.smsTemplate, business);

      if (!conversation) {
        conversation = await Db.saveConversation(Conversation, {
          business: businessId,
          lead: lead._id,
          customerPhone,
          customerName: lead.customerName,
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
          lastMessage: starterText,
          lastMessageAt: new Date(),
        });

        SocketService.emitConversationCreated(businessId, conversation);
      } else {
        conversation = await Db.updateConversation(
          Conversation,
          conversation._id,
          {
            lead: conversation.lead || lead._id,
            lastMessage: starterText,
            lastMessageAt: new Date(),
          },
        );

        SocketService.emitConversationUpdated(businessId, conversation);
      }

      /*
       * Create the business-facing missed-call alert before sending SMS.
       * Twilio may retry webhooks, so the alert service uses the Call SID (or
       * call-log ID fallback) as an idempotency key.
       */
      await AlertService.createMissedCallAlert({
        businessId,
        leadId: lead._id,
        customerName: lead.customerName,
        customerPhone,
        callLogId: callLog._id,
        providerCallId: callSid,
      });

      console.log("SENDING MISSED CALL SMS TO:", customerPhone);
      console.log("SENDING MISSED CALL SMS FROM:", twilioNumber);
      console.log("SMS BODY:", starterText);

      const sent = await sendSms({
        to: customerPhone,
        from: twilioNumber,
        body: starterText,
      });

      console.log("MISSED CALL SMS SENT:", sent?.sid || "NO SID RETURNED");

      /*
       * Save and emit the outbound missed-call message.
       */
      const outboundMessage = await Db.saveMessage(Message, {
        business: businessId,
        conversation: conversation._id,
        lead: lead._id,
        direction: "outbound",
        from: twilioNumber,
        to: customerPhone,
        body: starterText,
        provider: "twilio",
        providerMessageId: sent?.sid || "",
        status: "sent",
      });

      SocketService.emitMessageCreated(businessId, outboundMessage);

      /*
       * Mark the missed call as recovered after the SMS succeeds.
       */
      let updatedCallLog = callLog;

      if (callLog?._id) {
        updatedCallLog = await Db.updateCallLog(CallLog, callLog._id, {
          lead: lead._id,
          conversation: conversation._id,
          missedCallTextSent: true,
          recovered: true,
        });

        SocketService.emitCallUpdated(businessId, updatedCallLog);
      }

      /*
       * Tell connected dashboards to refetch their authoritative metrics.
       */
      SocketService.emitDashboardRefresh(
        businessId,
        "missed_call_recovery_completed",
      );

      res.type("text/xml");

      return res.status(200).send(
        xml(`
<Response>
  <Say>Thank you. The business has been notified.</Say>
</Response>`),
      );
    } catch (error) {
      console.error("Voice webhook error:", error);

      res.type("text/xml");
      return res.status(200).send(emptyTwiml());
    }
  }

  static async statusWebhook(req, res) {
    try {
      console.log("TWILIO STATUS BODY:", req.body);

      res.type("text/xml");
      return res.status(200).send(emptyTwiml());
    } catch (error) {
      console.error("Status webhook error:", error);

      res.type("text/xml");
      return res.status(200).send(emptyTwiml());
    }
  }

  static async handleInboundSms(req, res) {
    try {
      console.log("TWILIO SMS BODY:", req.body);

      const from = req.body.From;
      const to = req.body.To;
      const body = req.body.Body;
      const providerMessageId = req.body.MessageSid || "";

      if (!from || !to || !body) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const business = await Db.getBusinessByPhoneForWebhook(Business, to);

      console.log(
        "SMS BUSINESS FOUND:",
        business?.businessName || "NO BUSINESS",
      );

      if (!business) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const businessId = business._id;

      /*
       * Find, create, or update the lead.
       */
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

      /*
       * Find, create, or update the conversation.
       */
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

      /*
       * Save and emit the customer's inbound message.
       */
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

      /*
       * Surface each customer response in the Alert Center. Provider message
       * IDs keep this idempotent if Twilio retries the webhook.
       */
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
          conversation.humanTakeover === true ||
          ["high", "emergency"].includes(lead.urgency)
            ? "high"
            : "medium",
      });

      const messages = await Db.getMessagesForAI(Message, conversation._id);

      const shouldAIReply =
        conversation.aiEnabled !== false &&
        conversation.humanTakeover !== true &&
        conversation.status !== "closed";

      console.log("SHOULD AI REPLY:", shouldAIReply);

      if (shouldAIReply) {
        const aiReply = await generateAIReply({
          business,
          lead,
          messages,
        });

        console.log("AI REPLY:", aiReply);

        if (aiReply) {
          const sent = await sendSms({
            to: from,
            from: to,
            body: aiReply,
          });

          console.log("AI SMS SENT:", sent?.sid || "NO SID RETURNED");

          /*
           * Save and emit the AI-generated outbound message.
           */
          const outboundMessage = await Db.saveMessage(Message, {
            business: businessId,
            conversation: conversation._id,
            lead: lead._id,
            direction: "outbound",
            from: to,
            to: from,
            body: aiReply,
            provider: "twilio",
            providerMessageId: sent?.sid || "",
            status: "sent",
          });

          SocketService.emitMessageCreated(businessId, outboundMessage);

          /*
           * Update and emit the conversation with the AI response as the
           * latest message.
           */
          conversation = await Db.updateConversation(
            Conversation,
            conversation._id,
            {
              lastMessage: aiReply,
              lastMessageAt: new Date(),
            },
          );

          SocketService.emitConversationUpdated(businessId, conversation);
        }
      }

      SocketService.emitDashboardRefresh(businessId, "inbound_sms_processed");

      res.type("text/xml");
      return res.status(200).send(emptyTwiml());
    } catch (error) {
      console.error("Inbound SMS error:", error);

      res.type("text/xml");
      return res.status(200).send(emptyTwiml());
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

      console.log("MANUAL SMS TO:", to);
      console.log("MANUAL SMS FROM:", from);
      console.log("MANUAL SMS BODY:", body);

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
