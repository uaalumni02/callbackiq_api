import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import CallLog from "../models/callLog.js";

import { generateAIReply } from "../services/aiReplyService.js";
import { sendSms } from "../services/twilioSmsService.js";

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const emptyTwiml = () => xml("<Response></Response>");

const missedStatuses = new Set(["no-answer", "busy", "failed", "canceled"]);

const getPublicApiUrl = (req) => {
  return (
    process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get("host")}`
  );
};

class TwilioController {
  static async voiceWebhook(req, res) {
    try {
      const from = req.body.From;
      const to = req.body.To;

      const business = await Db.getBusinessByPhone(Business, to);

      if (!business) {
        res.type("text/xml");
        return res.status(200).send(
          xml(`
<Response>
  <Reject />
</Response>`),
        );
      }

      const forwardTo =
        business.forwardingPhone || business.businessPhone || business.phone;

      if (!forwardTo) {
        res.type("text/xml");
        return res.status(200).send(
          xml(`
<Response>
  <Say>Sorry, no one is available right now.</Say>
</Response>`),
        );
      }

      const statusUrl = `${getPublicApiUrl(req)}/api/twilio/status`;

      res.type("text/xml");
      return res.status(200).send(
        xml(`
<Response>
  <Dial
    timeout="20"
    action="${statusUrl}"
    method="POST"
    callerId="${to}"
  >
    <Number>${forwardTo}</Number>
  </Dial>
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
      const from = req.body.From;
      const to = req.body.To;
      const callSid = req.body.CallSid || "";
      const dialCallStatus = req.body.DialCallStatus || "";
      const callStatus = req.body.CallStatus || "";
      const status = dialCallStatus || callStatus;

      if (!from || !to) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const business = await Db.getBusinessByPhone(Business, to);

      if (!business) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const wasMissed = missedStatuses.has(status);

      await Db.saveCallLog(CallLog, {
        business: business._id,
        from,
        to,
        direction: "inbound",
        status: wasMissed ? "missed" : "answered",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: callSid,
        missedCallTextSent: false,
        recovered: false,
        notes: `Twilio call status: ${status}`,
      });

      if (!wasMissed) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      let lead = await Db.getLeadByBusinessAndPhone(Lead, business._id, from);

      if (!lead) {
        lead = await Db.saveLead(Lead, {
          business: business._id,
          customerName: "Missed Call Lead",
          phone: from,
          serviceNeeded: "Unknown",
          urgency: "medium",
          source: "missed_call",
          status: "new",
          estimatedValue: business.estimatedJobValue || 0,
          notes: "Lead created automatically from missed call.",
        });
      }

      let conversation = await Db.getConversationByBusinessAndPhone(
        Conversation,
        business._id,
        from,
      );

      const starterText =
        business.smsTemplate ||
        `Hi, this is ${business.businessName}. Sorry we missed your call. What service do you need help with today?`;

      if (!conversation) {
        conversation = await Db.saveConversation(Conversation, {
          business: business._id,
          lead: lead._id,
          customerPhone: from,
          customerName: lead.customerName,
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
          lastMessage: starterText,
          lastMessageAt: new Date(),
        });
      }

      const sent = await sendSms({
        to: from,
        from: to,
        body: starterText,
      });

      await Db.saveMessage(Message, {
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        direction: "outbound",
        from: to,
        to: from,
        body: starterText,
        provider: "twilio",
        providerMessageId: sent?.sid || "",
        status: "sent",
      });

      await Db.updateConversation(Conversation, conversation._id, {
        lastMessage: starterText,
        lastMessageAt: new Date(),
      });

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
      const from = req.body.From;
      const to = req.body.To;
      const body = req.body.Body;
      const providerMessageId = req.body.MessageSid || "";

      if (!from || !to || !body) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      const business = await Db.getBusinessByPhone(Business, to);

      if (!business) {
        res.type("text/xml");
        return res.status(200).send(emptyTwiml());
      }

      let lead = await Db.getLeadByBusinessAndPhone(Lead, business._id, from);

      if (!lead) {
        lead = await Db.saveLead(Lead, {
          business: business._id,
          customerName: "New SMS Lead",
          phone: from,
          serviceNeeded: "Unknown",
          source: "sms",
          status: "contacted",
          urgency: "medium",
          estimatedValue: business.estimatedJobValue || 0,
          notes: body,
        });
      } else if (lead.status === "new") {
        lead = await Db.updateLead(Lead, lead._id, {
          status: "contacted",
          notes: body,
        });
      }

      let conversation = await Db.getConversationByBusinessAndPhone(
        Conversation,
        business._id,
        from,
      );

      if (!conversation) {
        conversation = await Db.saveConversation(Conversation, {
          business: business._id,
          lead: lead._id,
          customerPhone: from,
          customerName: lead.customerName,
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
          lastMessage: body,
          lastMessageAt: new Date(),
        });
      } else {
        conversation = await Db.updateConversation(
          Conversation,
          conversation._id,
          {
            lastMessage: body,
            lastMessageAt: new Date(),
          },
        );
      }

      await Db.saveMessage(Message, {
        business: business._id,
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

      const messages = await Db.getMessagesByConversation(
        Message,
        conversation._id,
      );

      const shouldAIReply =
        conversation.aiEnabled !== false &&
        conversation.humanTakeover !== true &&
        conversation.status !== "closed";

      if (shouldAIReply) {
        const aiReply = await generateAIReply({
          business,
          lead,
          messages,
        });

        if (aiReply) {
          const sent = await sendSms({
            to: from,
            from: to,
            body: aiReply,
          });

          await Db.saveMessage(Message, {
            business: business._id,
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

          await Db.updateConversation(Conversation, conversation._id, {
            lastMessage: aiReply,
            lastMessageAt: new Date(),
          });
        }
      }

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

      const sent = await sendSms({ to, from, body });

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
