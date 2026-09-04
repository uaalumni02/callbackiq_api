// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: webhook
import { processInboundSmsJob } from "./messaging/inboundSmsJobProcessor.service.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import { sendSms } from "./twilioSmsService.js";
import { buildSmsRecoveryVoicePrompt } from "../voice/smsRecoveryVoicePrompt.service.js";
import AlertService from "./alert.service.js";
import SocketService from "./socket.service.js";
import { logOperationalEvent, logOperationalError } from "../helpers/logging/safeLogger.js";
import { isBusinessFeatureEnabled } from "../helpers/businessFeatures.js";
import { buildTwilioEventIdentity, getTwilioStatusEventType } from "../helpers/twilioEventKey.js";
import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
  failTwilioWebhookEvent,
  heartbeatTwilioWebhookEvent,
  waitForTwilioWebhookEventSettlement,
} from "./webhooks/twilioWebhookEvent.service.js";
import {
  classifyInboundSmsCommand,
  processInboundSmsCommand,
} from "./messaging/contactPreference.service.js";
import { sendIdempotentInboundSmsReply } from "./messaging/idempotentInboundSmsReply.service.js";
import { runInboundSmsLifecycleAfterClaim } from "./messaging/inboundSmsLifecycle.service.js";
import { buildMissedCallRecoveryText, normalizeSmsPhone } from "./messaging/smsCompliance.service.js";
import { parseInboundTwilioMedia, buildMediaOnlyAcknowledgement } from "./messaging/smsMedia.service.js";
import { getOrCreateSmsLeadAndConversation } from "./messaging/smsConversation.service.js";
import { enqueueInboundSmsJob } from "./messaging/smsProcessingQueue.service.js";
import { processTwilioMessageStatus } from "./messaging/smsDeliveryStatus.service.js";
import { resolveBusinessByTwilioNumber, resolveBusinessFromWebhookPhones, resolveTwilioNumberContext } from "./twilioBusinessResolver.service.js";
import { syncLatestAttribution } from "./marketingAttribution.service.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import { executeManualSmsOperation } from "./messaging/manualSmsOperation.service.js";
import { resolveBusinessForTwilioStatus } from "./twilioStatusBusinessResolver.service.js";
import { processTwilioCallStatus } from "./twilioCallStatus.service.js";

import { evaluateDeterministicInboundGuardrails } from "../helpers/ai/aiGuardrails.js";
import { isHumanHandoffStatusQuestion } from "./messaging/smsHandoff.service.js";
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const emptyTwiml = () => xml("<Response></Response>");
const sendXml = (res, { statusCode = 200, body = emptyTwiml() } = {}) => {
  res.type("text/xml");
  return res.status(statusCode).send(body);
};
const routingFailure = (res, receivedNumber, webhook) => {
  const number = String(receivedNumber || "").trim();
  logOperationalEvent("twilio.routing.unmapped_number", {
    webhook,
    to: number,
    code: "TWILIO_NUMBER_NOT_MAPPED",
  });
  res.set("X-CallBackIQ-Routing-Error", "TWILIO_NUMBER_NOT_MAPPED");
  return sendXml(res, { statusCode: 404 });
};

const cached = (res, event) =>
  sendXml(res, {
    statusCode: event?.responseStatusCode || 200,
    body: event?.responseBody || emptyTwiml(),
  });

const startWebhookHeartbeat = ({ eventId, leaseToken, res }) => {
  if (process.env.NODE_ENV === "test") return null;
  if (!eventId || !leaseToken) return null;
  const intervalMs = Math.max(
    1_000,
    Math.floor(Number(process.env.TWILIO_WEBHOOK_LEASE_MS || 5_000) / 3),
  );
  const timer = setInterval(() => {
    void heartbeatTwilioWebhookEvent({ eventId, leaseToken }).catch((error) =>
      logOperationalError("twilio.webhook.heartbeat_failed", error, {
        webhookEventId: eventId,
      }),
    );
  }, intervalMs);
  timer.unref?.();
  res.once("finish", () => clearInterval(timer));
  res.once("close", () => clearInterval(timer));
  return timer;
};

const saveOutbound = async ({ business, conversation, lead, from = "", to, body, sent, generatedBy, usageCategory, actorType, metadata }) => {
  const message = await Message.create({
    business: business._id,
    conversation: conversation._id,
    lead: lead?._id || conversation.lead || null,
    direction: "outbound",
    from: from || business.phone,
    to,
    body: sent?.body || body,
    provider: "twilio",
    providerMessageId: sent?.sid || "",
    status: sent?.suppressed ? "suppressed" : sent?.status || "sent",
    deliveryStatus: sent?.suppressed ? "suppressed" : sent?.status || "sent",
    encoding: sent?.encoding || "",
    segmentCount: sent?.segmentCount || 1,
    isAiGenerated: generatedBy === "ai",
    generatedBy,
    usageCategory,
    actorType,
    metadata,
  });
  SocketService.emitMessageCreated(business._id, message);
  return message;
};

const updateConversationLastMessage = async ({ businessId, conversation, body }) => {
  const updated = await Conversation.findByIdAndUpdate(
    conversation._id,
    { lastMessage: body, lastMessageAt: new Date() },
    { returnDocument: "after" },
  );
  SocketService.emitConversationUpdated(businessId, updated);
  return updated;
};

const failAndRespond = async ({
  event,
  leaseToken = "",
  error,
  res,
  eventName,
  statusCode = 200,
}) => {
  logOperationalError(eventName, error, { businessId: event?.business });
  const responseBody = emptyTwiml();
  if (event?._id) {
    await Promise.resolve(failTwilioWebhookEvent(event._id, error, {
      leaseToken,
      statusCode,
      contentType: "text/xml",
      responseBody,
    })).catch((persistError) =>
      logOperationalError(`${eventName}.event_failure_persist_failed`, persistError, {
        webhookEventId: event._id,
      }),
    );
  }
  return sendXml(res, { statusCode, body: responseBody });
};

export const handleSmsRecoveryVoiceWebhook = async (req, res) => {
  let webhookEvent = null;
  let webhookLeaseToken = "";
  try {
    const rawCustomerPhone = req.body.From || req.body.Caller || "";
    const twilioNumber = req.body.To || req.body.Called || "";
    const callSid = String(req.body.CallSid || "").trim();
    const customerPhone = normalizeSmsPhone(rawCustomerPhone);

    logOperationalEvent("twilio.voice.received", {
      from: rawCustomerPhone,
      to: twilioNumber,
      providerCallSid: callSid,
    });
    if (!customerPhone || !twilioNumber) return sendXml(res);

    const numberContext =
      typeof resolveTwilioNumberContext === "function"
        ? await resolveTwilioNumberContext(twilioNumber)
        : null;
    const business =
      numberContext?.business ||
      (await resolveBusinessByTwilioNumber(twilioNumber));
    logOperationalEvent("twilio.voice.business_resolved", {
      businessId: business?._id || null,
      resolved: Boolean(business),
    });
    if (!business) {
      return routingFailure(res, twilioNumber, "inbound_voice");
    }
    const eventIdentity = buildTwilioEventIdentity("inbound_voice", req.body);
    const claim = await claimTwilioWebhookEvent({
      businessId: business._id,
      ...eventIdentity,
      requestMetadata: { from: customerPhone, to: twilioNumber },
    });
    if (!claim.claimed) return cached(res, claim.event);
    webhookEvent = claim.event;
    webhookLeaseToken = claim.leaseToken;
    startWebhookHeartbeat({
      eventId: webhookEvent._id,
      leaseToken: webhookLeaseToken,
      res,
    });

    const callLog = await CallLog.findOneAndUpdate(
      { business: business._id, providerCallId: callSid },
      {
        $setOnInsert: {
          business: business._id,
          from: customerPhone,
          to: twilioNumber,
          direction: "inbound",
          status: "missed",
          durationSeconds: 0,
          provider: "twilio",
          providerCallId: callSid,
          marketingSource: numberContext?.marketingSource?._id || null,
          trackingNumber: numberContext?.trackingNumber?._id || null,
          attribution: numberContext?.attribution || {},
          missedCallTextSent: false,
          missedCallTextDelivered: false,
          recovered: false,
          notes: "Missed call forwarded to CallBackIQ Twilio number.",
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    SocketService.emitCallCreated(business._id, callLog);

    const { lead, conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone,
      source: "missed_call",
      reopenEligible: true,
      // CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: duplicate webhook delivery keeps the same journey; a new CallSid resets active booking state.
      recoveryJourneyKey: callSid,
    });
    if (
      numberContext?.trackingNumber ||
      numberContext?.marketingSource
    ) {
      await syncLatestAttribution({
        businessId: business._id,
        leadId: lead._id,
        conversationId: conversation._id,
        trackingNumber: numberContext?.trackingNumber || null,
        marketingSource: numberContext?.marketingSource || null,
        calledPhone: twilioNumber,
      });
    }
    await CallLog.findByIdAndUpdate(callLog._id, {
      lead: lead._id,
      conversation: conversation._id,
    });
    await AlertService.createMissedCallAlert({
      businessId: business._id,
      leadId: lead._id,
      customerName: lead.customerName,
      customerPhone,
      callLogId: callLog._id,
      providerCallId: callSid,
    });

    const smsFeatureEnabled = isBusinessFeatureEnabled(business, "missedCallSmsEnabled");
    // CALLBACKIQ_SMS_TAKEOVER_LIFECYCLE
    // Never invite a customer to reply to an automated recovery text while the
    // conversation is intentionally owned by a human or otherwise AI-ineligible.
    const recoveryAutomationEligible =
      conversation.aiEnabled !== false &&
      conversation.humanTakeover !== true &&
      conversation.status !== "closed" &&
      conversation.status !== "archived";
    const smsEnabled = smsFeatureEnabled && recoveryAutomationEligible;
    const starterText = buildMissedCallRecoveryText({ business });
    let smsStatus = smsEnabled ? "failed" : "disabled";
    if (smsFeatureEnabled && !recoveryAutomationEligible) {
      logOperationalEvent("twilio.voice.sms_skipped_conversation_muted", {
        businessId: business._id,
        conversationId: conversation._id,
        aiEnabled: conversation.aiEnabled,
        humanTakeover: conversation.humanTakeover,
        conversationStatus: conversation.status,
      });
    }
    let sentResult = null;

    if (smsEnabled) {
      try {
        sentResult = await sendSms({
          business,
          businessId: business._id,
          from: numberContext?.trackingNumber?.phoneNumber || business.phone,
          to: customerPhone,
          body: starterText,
          actorType: "webhook",
          source: "missed_call_recovery",
          usageCategory: "missed_call_recovery",
          conversationId: conversation._id,
          leadId: lead._id,
          directResponse: true,
          requireOptOutDisclosure: true,
          metadata: { providerCallSid: callSid },
        });
        smsStatus = sentResult?.suppressed ? "suppressed" : "sent";

        if (!sentResult?.suppressed) {
          await saveOutbound({
            business,
            conversation,
            lead,
            from: numberContext?.trackingNumber?.phoneNumber || business.phone,
            to: customerPhone,
            body: starterText,
            sent: sentResult,
            generatedBy: "automation",
            usageCategory: "missed_call_recovery",
            actorType: "automation",
            metadata: { source: "missed_call_recovery", providerCallSid: callSid },
          });
          await updateConversationLastMessage({
            businessId: business._id,
            conversation,
            body: starterText,
          });
          logOperationalEvent("twilio.voice.sms_sent", {
            businessId: business._id,
            providerMessageId: sentResult?.sid || "",
          });
        } else {
          logOperationalEvent("twilio.voice.sms_suppressed", {
            businessId: business._id,
            reason: sentResult.reason || "customer_opted_out",
            providerCode: sentResult.providerCode || null,
          });
        }
      } catch (smsError) {
        logOperationalError("twilio.voice.sms_failed", smsError, {
          businessId: business._id,
          providerCallSid: callSid,
          errorCode: smsError?.code || "error",
        });
      }
    }

    const updatedCallLog = await CallLog.findByIdAndUpdate(
      callLog._id,
      {
        missedCallTextSent: Boolean(sentResult && !sentResult.suppressed),
        missedCallTextDelivered: false,
        smsProviderMessageId: sentResult?.sid || "",
        smsDeliveryStatus: sentResult?.suppressed
          ? "suppressed"
          : sentResult?.status || smsStatus,
        smsSegmentCount: sentResult?.segmentCount || 0,
        recovered: false,
      },
      { returnDocument: "after" },
    );
    SocketService.emitCallUpdated(business._id, updatedCallLog);
    SocketService.emitDashboardRefresh(
      business._id,
      sentResult && !sentResult.suppressed
        ? "missed_call_sms_accepted"
        : "missed_call_recorded",
    );

    const voicePrompt = buildSmsRecoveryVoicePrompt({
      businessName: business.businessName,
      smsEnabled,
      smsStatus,
    });
    const responseBody = xml(`\n<Response>\n  <Say>${voicePrompt}</Say>\n</Response>`);
    await completeTwilioWebhookEvent(webhookEvent._id, {
      leaseToken: webhookLeaseToken,
      statusCode: 200,
      contentType: "text/xml",
      responseBody,
    });
    return sendXml(res, { body: responseBody });
  } catch (error) {
    return failAndRespond({ event: webhookEvent, leaseToken: webhookLeaseToken, error, res, eventName: "twilio.voice.failed" });
  }
};

export const handleTwilioStatusWebhook = async (req, res) => {
  let webhookEvent = null;
  let webhookLeaseToken = "";
  try {
    // CALLBACKIQ_PRODUCTION_READINESS: provider record is authoritative.
    const business =
      (await resolveBusinessForTwilioStatus(req.body)) ||
      (await resolveBusinessFromWebhookPhones([
        req.body.To,
        req.body.From,
        req.body.Called,
        req.body.Caller,
      ]));
    if (!business) {
      return routingFailure(
        res,
        req.body.To || req.body.Called || req.body.From || req.body.Caller,
        "status",
      );
    }
    const eventType = getTwilioStatusEventType(req.body);
    const eventIdentity = buildTwilioEventIdentity(eventType, req.body);
    const claim = await claimTwilioWebhookEvent({
      businessId: business._id,
      ...eventIdentity,
      requestMetadata: {
        status: req.body.CallStatus || req.body.MessageStatus || req.body.SmsStatus || "",
      },
    });
    if (!claim.claimed) return cached(res, claim.event);
    webhookEvent = claim.event;
    webhookLeaseToken = claim.leaseToken;
    startWebhookHeartbeat({
      eventId: webhookEvent._id,
      leaseToken: webhookLeaseToken,
      res,
    });

    if (eventType === "message_status") {
      await processTwilioMessageStatus({ businessId: business._id, payload: req.body });
    } else if (req.body.CallSid) {
      await processTwilioCallStatus({ businessId: business._id, payload: req.body });
    }

    const responseBody = emptyTwiml();
    await completeTwilioWebhookEvent(webhookEvent._id, {
      leaseToken: webhookLeaseToken,
      statusCode: 200,
      contentType: "text/xml",
      responseBody,
    });
    return sendXml(res, { body: responseBody });
  } catch (error) {
    return failAndRespond({ event: webhookEvent, leaseToken: webhookLeaseToken, error, res, eventName: "twilio.status.failed" });
  }
};

const sendCommandReply = async ({ business, conversation, lead, to, commandResult }) => {
  if (!commandResult.reply) return null;
  const sent = await sendSms({
    business,
    businessId: business._id,
    from: conversation.replyFromPhone || business.phone,
    to,
    body: commandResult.reply,
    allowOptedOut: commandResult.allowOptedOutReply,
    bypassUsageLimits: true,
    actorType: "webhook",
    source: "inbound_sms_command",
    usageCategory: "compliance",
    conversationId: conversation._id,
    leadId: lead._id,
    directResponse: true,
    metadata: { action: commandResult.action },
  });
  if (!sent?.suppressed) {
    await saveOutbound({
      business,
      conversation,
      lead,
      from: conversation.replyFromPhone || business.phone,
      to,
      body: commandResult.reply,
      sent,
      generatedBy: "guardrail",
      usageCategory: "compliance",
      actorType: "webhook",
      metadata: { source: "inbound_sms_command", action: commandResult.action },
    });
  }
  return sent;
};

export const handleInboundSmsWebhook = async (req, res) => {
  let webhookEvent = null;
  let webhookLeaseToken = "";
  try {
    const rawFrom = req.body.From || "";
    const to = String(req.body.To || "").trim();
    const body = String(req.body.Body || "").trim();
    const media = parseInboundTwilioMedia(req.body);
    const providerMessageId = String(req.body.MessageSid || req.body.SmsSid || "").trim();
    // CALLBACKIQ_TWILIO_OPTOUTTYPE_INGRESS
    const twilioOptOutType = String(req.body.OptOutType || "").trim();
    const commandClassification = body
      ? classifyInboundSmsCommand(body, { twilioOptOutType })
      : { handled: false };
    const mediaOnly = !body && media.length > 0;
    const from = normalizeSmsPhone(rawFrom);
    if (!from || !to || (!body && media.length === 0)) return sendXml(res);

    const numberContext =
      typeof resolveTwilioNumberContext === "function"
        ? await resolveTwilioNumberContext(to)
        : null;
    const business =
      numberContext?.business ||
      (await resolveBusinessByTwilioNumber(to));
    logOperationalEvent("twilio.sms.received", {
      from: rawFrom,
      to,
      providerMessageId,
      mediaCount: media.length,
      businessId: business?._id || null,
      resolved: Boolean(business),
    });
    if (!business) {
      return routingFailure(res, to, "inbound_sms");
    }
    const eventIdentity = buildTwilioEventIdentity("inbound_sms", req.body);
    const claimInput = {
      businessId: business._id,
      ...eventIdentity,
      requestMetadata: { from, to, mediaCount: media.length },
    };
    let claim = await claimTwilioWebhookEvent(claimInput);

    if (!claim.claimed) {
      if (claim.event?.status === "completed") {
        return cached(res, claim.event);
      }

      const settled = await waitForTwilioWebhookEventSettlement(
        claim.event?._id,
      );
      if (settled?.status === "completed") {
        return cached(res, settled);
      }

      // The original process may have died after claiming but before durable
      // Message persistence. Re-claim only after its renewable lease expires.
      claim = await claimTwilioWebhookEvent(claimInput);
      if (!claim.claimed) {
        res.set("Retry-After", "1");
        return sendXml(res, { statusCode: 503 });
      }
    }
    webhookEvent = claim.event;
    webhookLeaseToken = claim.leaseToken;
    startWebhookHeartbeat({
      eventId: webhookEvent._id,
      leaseToken: webhookLeaseToken,
      res,
    });

    const { lead, conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: from,
      body: body || (media.length ? "Attachment received" : ""),
      source: "sms",
      reopenEligible: true,
    });

    const postHandoffStatusEligible =
      conversation.humanTakeover === true &&
      isHumanHandoffStatusQuestion(body);
    // CALLBACKIQ_DURABLE_PROCESSING_INTENT
    const processingRequired =
      !commandClassification.handled &&
      !mediaOnly &&
      (postHandoffStatusEligible ||
        (conversation.aiEnabled !== false &&
          conversation.humanTakeover !== true &&
          conversation.status !== "closed" &&
          conversation.status !== "archived"));
    if (
      numberContext?.trackingNumber ||
      numberContext?.marketingSource
    ) {
      await syncLatestAttribution({
        businessId: business._id,
        leadId: lead._id,
        conversationId: conversation._id,
        trackingNumber: numberContext?.trackingNumber || null,
        marketingSource: numberContext?.marketingSource || null,
        calledPhone: to,
      });
    }

    const inboundMessage = await Message.findOneAndUpdate(
      { business: business._id, providerMessageId },
      {
        // CALLBACKIQ_DURABLE_MESSAGE_INTENT
        // Refresh processing intent even when a failed webhook reclaims an
        // inbound Message that was already persisted before the failure.
        $set: {
          "metadata.twilioOptOutType": twilioOptOutType,
          "metadata.processingRequired": processingRequired,
        },
        $setOnInsert: {
          business: business._id,
          conversation: conversation._id,
          lead: lead._id,
          direction: "inbound",
          generatedBy: "customer",
          actorType: "customer",
          from,
          to,
          body,
          media,
          provider: "twilio",
          providerMessageId,
          status: "received",
          deliveryStatus: "received",
          segmentCount: 0,
          "metadata.processingEnqueuedAt": null,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    SocketService.emitMessageCreated(business._id, inboundMessage);

    await runInboundSmsLifecycleAfterClaim({
      business,
      conversation,
      lead,
      inboundMessage,
    });

    // CALLBACKIQ_IDEMPOTENT_COMMAND_MMS_REPLY
    if (commandClassification.handled) {
      const commandResult = await processInboundSmsCommand({
        businessId: business._id,
        phone: from,
        messageBody: body,
        twilioOptOutType,
        suppressProviderManagedReply: true,
      });

      const updates = {
        lastMessage: body,
        lastMessageAt: new Date(),
        ...(commandResult.action === "opt_out"
          ? { aiEnabled: false }
          : {}),
        ...(commandResult.action === "opt_in" &&
        conversation.humanTakeover !== true
          ? { aiEnabled: true, status: "open" }
          : {}),
      };
      const updatedConversation = await Conversation.findByIdAndUpdate(
        conversation._id,
        updates,
        { returnDocument: "after" },
      );
      SocketService.emitConversationUpdated(
        business._id,
        updatedConversation,
      );

      if (commandResult.reply) {
        await sendIdempotentInboundSmsReply({
          business,
          conversation: updatedConversation,
          lead,
          inboundMessage,
          body: commandResult.reply,
          generatedBy: "guardrail",
          usageCategory: "compliance",
          actorType: "webhook",
          allowOptedOut: commandResult.allowOptedOutReply === true,
          bypassUsageLimits: true,
          metadata: {
            source: "inbound_sms_command",
            action: commandResult.action,
            providerManaged: commandResult.providerManaged === true,
          },
        });
      }
    } else if (mediaOnly) {
      const reply = buildMediaOnlyAcknowledgement(media);
      await sendIdempotentInboundSmsReply({
        business,
        conversation,
        lead,
        inboundMessage,
        body: reply,
        generatedBy: "guardrail",
        usageCategory: "guardrail_reply",
        actorType: "webhook",
        metadata: {
          source: "inbound_mms_acknowledgement",
          mediaCount: media.length,
        },
      });
    } else if (processingRequired) {
      const queuedJob = await enqueueInboundSmsJob({
        businessId: business._id,
        inboundMessageId: inboundMessage._id,
        conversationId: conversation._id,
        leadId: lead._id,
        providerMessageId,
      });
      await Message.updateOne(
        { _id: inboundMessage._id },
        { $set: { "metadata.processingEnqueuedAt": new Date() } },
      );
      if (process.env.NODE_ENV === "test" && req.app && queuedJob) {
        await processInboundSmsJob(queuedJob);
      }
      logOperationalEvent("twilio.sms.ai_queued", {
        businessId: business._id,
        conversationId: conversation._id,
        inboundMessageId: inboundMessage._id,
        postHandoffStatusEligible,
      });
    } else {
      logOperationalEvent("twilio.sms.ai_skipped", {
        businessId: business._id,
        conversationId: conversation._id,
        aiEnabled: conversation.aiEnabled,
        humanTakeover: conversation.humanTakeover,
        conversationStatus: conversation.status,
      });
    }

    const customerReplyAssessment = body
      ? evaluateDeterministicInboundGuardrails({
          customerMessage: body,
          recentMessages: [],
        }) || { alertPriority: "low", riskFlags: [] }
      : { alertPriority: "low", riskFlags: [] };
    const customerReplyPriority =
      customerReplyAssessment.alertPriority === "critical" ||
      customerReplyAssessment.riskFlags?.includes("safety_hazard")
        ? "critical"
        : conversation.humanTakeover
          ? "high"
          : "medium";

    await AlertService.createCustomerReplyAlert({
      businessId: business._id,
      leadId: lead._id,
      conversationId: conversation._id,
      messageId: inboundMessage._id,
      providerMessageId,
      customerName: lead.customerName,
      customerPhone: from,
      messageBody: body || `[${media.length} attachment${media.length === 1 ? "" : "s"}]`,
      priority: customerReplyPriority,
    });
    SocketService.emitDashboardRefresh(business._id, "inbound_sms_accepted");

    const responseBody = emptyTwiml();
    await completeTwilioWebhookEvent(webhookEvent._id, {
      leaseToken: webhookLeaseToken,
      statusCode: 200,
      contentType: "text/xml",
      responseBody,
    });
    return sendXml(res, { body: responseBody });
  } catch (error) {
    return failAndRespond({
      event: webhookEvent,
      leaseToken: webhookLeaseToken,
      error,
      res,
      eventName: "twilio.sms.failed",
      statusCode: webhookEvent?._id ? 503 : 200,
    });
  }
};

export const handleManualSmsRequest = async (req, res) => {
  try {
    const business = req.business;
    const result = await executeManualSmsOperation({
      business,
      actorId: req.user?.userId || req.user?._id || null,
      to: req.body?.to,
      body: req.body?.body,
      conversationId: req.body?.conversationId,
      operationId:
        req.body?.operationId ||
        req.body?.clientOperationId ||
        req.get?.("Idempotency-Key") ||
        req.get?.("X-Idempotency-Key") ||
        "",
      source: "manual_sms_api",
    });
    if (result.blocked) {
      return res.status(result.statusCode || 409).json({
        success: false,
        message: result.message || "Manual SMS was blocked.",
        data: { reason: result.reason, operationId: result.operation?.operationId },
      });
    }
    return res.status(result.completed ? 201 : 202).json({
      success: true,
      message: result.completed
        ? "Manual SMS accepted by Twilio and saved."
        : "Manual SMS is being reconciled.",
      data: result.message || null,
      operation: {
        id: result.operation?._id,
        operationId: result.operation?.operationId,
        state: result.operation?.state,
        replayed: Boolean(result.replayed),
      },
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    return res.status(statusCode).json({
      success: false,
      message: error?.message || "Unable to send manual SMS.",
      code: error?.code || "MANUAL_SMS_FAILED",
      data: { operationId: error?.manualSmsOperationId || null, providerAccepted: Boolean(error?.providerAccepted) },
    });
  }
};
