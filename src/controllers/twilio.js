import twilio from "twilio";

import Db from "../db/db.js";
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";

const { VoiceResponse, MessagingResponse } = twilio.twiml;

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

const normalizePhone = (phone = "") => String(phone).trim();

const mapDialStatusToCallStatus = (dialStatus, durationSeconds = 0) => {
  if (dialStatus === "completed" && Number(durationSeconds) > 0) {
    return "answered";
  }

  if (dialStatus === "no-answer") {
    return "no_answer";
  }

  if (dialStatus === "busy") {
    return "busy";
  }

  if (dialStatus === "failed") {
    return "failed";
  }

  return "missed";
};

const shouldTriggerMissedCallRecovery = (status, durationSeconds = 0) => {
  const missedStatuses = ["missed", "no_answer", "busy", "failed"];

  return missedStatuses.includes(status) || Number(durationSeconds) === 0;
};

const renderSmsTemplate = (business) => {
  const template =
    business?.smsTemplate ||
    "Hi, this is {{businessName}}. Sorry we missed your call. What service do you need help with today?";

  return template.replace(
    "{{businessName}}",
    business?.businessName || "the business",
  );
};

const findBusinessForTwilioNumber = async (twilioNumber) => {
  const normalizedNumber = normalizePhone(twilioNumber);

  let business = await Db.getBusinessByPhone(Business, normalizedNumber);

  if (!business) {
    business = await Db.getFirstBusiness(Business);
  }

  return business;
};

const createOrFindLead = async ({ business, customerPhone }) => {
  let lead = await Db.getLeadByBusinessAndPhone(
    Lead,
    business._id,
    customerPhone,
  );

  if (!lead) {
    lead = await Db.saveLead(Lead, {
      business: business._id,
      customerName: "",
      phone: customerPhone,
      serviceNeeded: "Unknown - missed call follow-up needed",
      urgency: "medium",
      leadQualityScore: 50,
      estimatedValue: business.estimatedJobValue || 0,
      status: "new",
      source: "missed_call",
      summary: "Lead created automatically from a missed call.",
      notes: "Customer called but the business did not answer.",
    });
  }

  return lead;
};

const createOrFindConversation = async ({ business, lead, customerPhone }) => {
  let conversation = await Db.getConversationByBusinessAndPhone(
    Conversation,
    business._id,
    customerPhone,
  );

  if (!conversation) {
    conversation = await Db.saveConversation(Conversation, {
      business: business._id,
      lead: lead?._id || null,
      customerPhone,
      customerName: lead?.customerName || "",
      status: "open",
      lastMessage: "",
      lastMessageAt: null,
    });
  }

  return conversation;
};

class TwilioController {
  static async voiceWebhook(req, res) {
    const twiml = new VoiceResponse();

    try {
      const from = normalizePhone(req.body.From);
      const to = normalizePhone(req.body.To);
      const providerCallId = req.body.CallSid;

      const business = await findBusinessForTwilioNumber(to);

      if (!business) {
        twiml.say("No business is configured for this number.");
        res.type("text/xml");
        return res.status(200).send(twiml.toString());
      }

      const callLog = await Db.saveCallLog(CallLog, {
        business: business._id,
        from,
        to,
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId,
        missedCallTextSent: false,
        recovered: false,
        notes: "Inbound call received through Twilio.",
      });

      const publicApiUrl = process.env.PUBLIC_API_URL;

      if (!publicApiUrl) {
        twiml.say("Callback system is not configured correctly.");
        res.type("text/xml");
        return res.status(200).send(twiml.toString());
      }

      const dial = twiml.dial({
        timeout: 20,
        action: `${publicApiUrl}/api/twilio/status?callLogId=${callLog._id}`,
        method: "POST",
      });

      dial.number(business.phone);

      res.type("text/xml");
      return res.status(200).send(twiml.toString());
    } catch (error) {
      console.error("Error in Twilio voiceWebhook:", error);

      twiml.say("There was an error connecting your call.");
      res.type("text/xml");
      return res.status(200).send(twiml.toString());
    }
  }

  static async statusWebhook(req, res) {
    try {
      const { callLogId } = req.query;

      const providerCallId = req.body.CallSid;
      const dialStatus = req.body.DialCallStatus;
      const durationSeconds = Number(req.body.DialCallDuration || 0);

      const mappedStatus = mapDialStatusToCallStatus(
        dialStatus,
        durationSeconds,
      );

      let callLog = null;

      if (callLogId) {
        callLog = await Db.updateCallLog(CallLog, callLogId, {
          status: mappedStatus,
          durationSeconds,
        });
      } else if (providerCallId) {
        callLog = await Db.updateCallLogByProviderCallId(
          CallLog,
          providerCallId,
          {
            status: mappedStatus,
            durationSeconds,
          },
        );
      }

      if (!callLog) {
        return res.status(200).json({
          success: true,
          message: "No matching call log found",
        });
      }

      const business =
        callLog.business?._id && callLog.business.businessName
          ? callLog.business
          : await Db.getBusinessById(Business, callLog.business);

      const customerPhone = normalizePhone(callLog.from);

      if (shouldTriggerMissedCallRecovery(mappedStatus, durationSeconds)) {
        const lead = await createOrFindLead({
          business,
          customerPhone,
        });

        const conversation = await createOrFindConversation({
          business,
          lead,
          customerPhone,
        });

        const smsBody = renderSmsTemplate(business);

        let smsSent = false;
        let providerMessageId = "";

        try {
          const sentMessage = await client.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: customerPhone,
            body: smsBody,
          });

          smsSent = true;
          providerMessageId = sentMessage.sid;
        } catch (smsError) {
          console.error("Error sending missed-call SMS:", smsError.message);
        }

        await Db.saveMessage(Message, {
          business: business._id,
          conversation: conversation._id,
          lead: lead._id,
          direction: "outbound",
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone,
          body: smsBody,
          provider: "twilio",
          providerMessageId,
          status: smsSent ? "sent" : "failed",
        });

        await Db.updateConversation(Conversation, conversation._id, {
          lastMessage: smsBody,
          lastMessageAt: new Date(),
        });

        await Db.updateCallLog(CallLog, callLog._id, {
          lead: lead._id,
          conversation: conversation._id,
          missedCallTextSent: smsSent,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Call status processed",
        data: {
          callStatus: mappedStatus,
          durationSeconds,
        },
      });
    } catch (error) {
      console.error("Error in Twilio statusWebhook:", error);

      return res.status(500).json({
        success: false,
        message: "Error processing Twilio call status",
      });
    }
  }

  static async smsWebhook(req, res) {
    const twiml = new MessagingResponse();

    try {
      const from = normalizePhone(req.body.From);
      const to = normalizePhone(req.body.To);
      const body = req.body.Body || "";
      const providerMessageId = req.body.MessageSid || "";

      const business = await findBusinessForTwilioNumber(to);

      if (!business) {
        res.type("text/xml");
        return res.status(200).send(twiml.toString());
      }

      let lead = await Db.getLeadByBusinessAndPhone(Lead, business._id, from);

      if (!lead) {
        lead = await Db.saveLead(Lead, {
          business: business._id,
          customerName: "",
          phone: from,
          serviceNeeded: "Unknown - customer replied by SMS",
          urgency: "medium",
          leadQualityScore: 50,
          estimatedValue: business.estimatedJobValue || 0,
          status: "contacted",
          source: "sms",
          summary: "Lead created from inbound customer SMS.",
          notes: body,
        });
      } else if (lead.status === "new") {
        lead = await Db.updateLead(Lead, lead._id, {
          status: "contacted",
        });
      }

      const conversation = await createOrFindConversation({
        business,
        lead,
        customerPhone: from,
      });

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

      await Db.updateConversation(Conversation, conversation._id, {
        lastMessage: body,
        lastMessageAt: new Date(),
      });

      res.type("text/xml");
      return res.status(200).send(twiml.toString());
    } catch (error) {
      console.error("Error in Twilio smsWebhook:", error);

      res.type("text/xml");
      return res.status(200).send(twiml.toString());
    }
  }

  static async sendManualSms(req, res) {
    try {
      const { to, body, conversationId, leadId } = req.body;

      if (!to || !body || !conversationId) {
        return res.status(400).json({
          success: false,
          message: "to, body, and conversationId are required",
        });
      }

      const sentMessage = await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to,
        body,
      });

      return res.status(200).json({
        success: true,
        message: "SMS sent successfully",
        data: {
          to,
          body,
          conversationId,
          leadId: leadId || null,
          providerMessageId: sentMessage.sid,
        },
      });
    } catch (error) {
      console.error("Error in sendManualSms:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to send SMS",
      });
    }
  }
}

export default TwilioController;
