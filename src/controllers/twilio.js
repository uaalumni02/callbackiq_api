import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import { generateAIReply } from "../services/aiReplyService.js";
import { sendSms } from "../services/twilioSmsService.js";

const emptyTwiml = () =>
  `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

class TwilioController {
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

          // FIXED
          status: "contacted",

          urgency: "medium",
          estimatedValue: business.estimatedJobValue || 0,

          // FIXED
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

          // FIXED
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
}

export default TwilioController;
