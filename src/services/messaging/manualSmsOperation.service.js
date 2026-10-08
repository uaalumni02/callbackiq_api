import crypto from "crypto";

import Conversation from "../../models/conversation.js";
import ManualSmsOperation from "../../models/manualSmsOperation.js";
import Message from "../../models/message.js";
import { sendSms } from "../twilioSmsService.js";
import {
  findCommunicationOperation,
  markCommunicationUsageUncertain,
  releaseCommunicationUsageReservation,
} from "../communicationUsageReservation.service.js";
import SocketService from "../socket.service.js";
import { evaluateManualSmsPolicy } from "./manualSmsPolicy.service.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const normalizeOperationId = (value) =>
  String(value || crypto.randomUUID())
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "")
    .slice(0, 160) || crypto.randomUUID();
const fingerprint = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");


const communicationOperationKey = (businessId, operationId) =>
  `manual_sms:${businessId}:${operationId}`;

const reconcileDispatchingOperation = async ({ operation, business }) => {
  const lifecycle = await findCommunicationOperation(
    communicationOperationKey(business._id, operation.operationId),
  );
  if (!lifecycle) {
    operation.state = "failed";
    operation.failureCode = "dispatch_record_missing";
    operation.failureMessage =
      "The prior dispatch did not reach the provider reservation stage and can be retried safely.";
    await operation.save();
    return { retryable: true };
  }
  if (lifecycle.state === "committed") {
    operation.state = "provider_accepted";
    operation.providerMessageId = lifecycle.providerOperationId || operation.providerMessageId;
    operation.providerStatus = lifecycle.providerStatus || operation.providerStatus || "sent";
    operation.metadata = { ...operation.metadata, providerBody: lifecycle.metadata?.providerRequest?.body || operation.body };
    await operation.save();
    return { accepted: true };
  }
  if (lifecycle.state === "uncertain" && lifecycle.providerOperationId) {
    operation.state = "provider_accepted";
    operation.providerMessageId = lifecycle.providerOperationId;
    operation.providerStatus = lifecycle.providerStatus || "queued";
    operation.metadata = { ...operation.metadata, providerBody: lifecycle.metadata?.providerRequest?.body || operation.body };
    await operation.save();
    return { accepted: true };
  }
  if (lifecycle.state === "uncertain") {
    operation.state = "reconciliation_required";
    operation.failureCode = "provider_outcome_uncertain";
    operation.failureMessage =
      "Twilio may have accepted this message. Reconcile the provider operation before retrying.";
    await operation.save();
    return { pending: true };
  }
  if (lifecycle.state === "released") {
    operation.state = "failed";
    operation.failureCode = lifecycle.releaseReason || "provider_rejected";
    operation.failureMessage =
      "The prior provider attempt was conclusively rejected and can be retried with the same operation ID.";
    await operation.save();
    return { retryable: true };
  }
  if (lifecycle.state === "pending" && new Date(lifecycle.leaseExpiresAt) <= new Date()) {
    if (lifecycle.providerDispatchStartedAt !== null) {
      await markCommunicationUsageUncertain({ reservation: lifecycle, error: { code: "SMS_DISPATCH_INTERRUPTED" } });
      operation.state = "reconciliation_required";
      operation.failureCode = "provider_outcome_uncertain";
      operation.failureMessage = "The previous text may have reached the customer. Check delivery before sending again.";
      await operation.save();
      return { pending: true };
    }
    await releaseCommunicationUsageReservation({
      reservation: lifecycle,
      reason: "expired_manual_sms_dispatch",
    });
    operation.state = "failed";
    operation.failureCode = "dispatch_lease_expired";
    operation.failureMessage =
      "The prior dispatch worker stopped before provider acceptance. The operation can be retried safely.";
    await operation.save();
    return { retryable: true };
  }
  return { pending: true };
};

const responseFromOperation = async (operation) => {
  const message = operation.message
    ? await Message.findById(operation.message)
    : null;
  return {
    operation,
    message,
    replayed: true,
    accepted: ["provider_accepted", "completed", "reconciliation_required"].includes(
      operation.state,
    ),
    completed: operation.state === "completed",
    blocked: operation.state === "blocked",
  };
};

const claimOperation = async ({
  business,
  conversation,
  lead,
  actorId,
  operationId,
  to,
  body,
  source,
}) => {
  const now = new Date();
  const resolvedOperationId = normalizeOperationId(operationId);
  const bodyFingerprint = fingerprint(`${to}\n${body}`);
  let operation;
  try {
    operation = await ManualSmsOperation.findOneAndUpdate(
      { business: business._id, operationId: resolvedOperationId },
      {
        $setOnInsert: {
          business: business._id,
          conversation: conversation._id,
          lead: lead?._id || conversation.lead || null,
          actor: actorId,
          operationId: resolvedOperationId,
          state: "created",
          to,
          body,
          bodyFingerprint,
          metadata: { source },
          purgeAt: new Date(now.getTime() + RETENTION_MS),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    operation = await ManualSmsOperation.findOne({
      business: business._id,
      operationId: resolvedOperationId,
    });
  }
  if (!operation) {
    const error = new Error("Unable to claim the manual SMS operation.");
    error.code = "SMS_OPERATION_CLAIM_FAILED";
    error.statusCode = 503;
    throw error;
  }
  if (
    String(operation.conversation) !== String(conversation._id) ||
    operation.bodyFingerprint !== bodyFingerprint
  ) {
    const error = new Error("The idempotency key was already used for a different manual message.");
    error.code = "SMS_OPERATION_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
  return operation;
};

const persistAcceptedOperation = async ({ operation, business, conversation, lead, actorId }) => {
  const message = await Message.findOneAndUpdate(
    { business: business._id, clientOperationId: operation.operationId },
    {
      $setOnInsert: {
        business: business._id,
        conversation: conversation._id,
        lead: lead?._id || conversation.lead || null,
        direction: "outbound",
        from: conversation.replyFromPhone || business.phone,
        to: operation.to,
        body: operation.metadata?.providerBody || operation.body,
        provider: "twilio",
        providerMessageId: operation.providerMessageId,
        clientOperationId: operation.operationId,
        status: operation.providerStatus || "sent",
        deliveryStatus: operation.providerStatus || "sent",
        generatedBy: "user",
        usageCategory: "manual_sms",
        actorType: "user",
        actorId,
        deliveryAttemptedAt: operation.lastAttemptAt || new Date(),
        metadata: {
          source: operation.metadata?.source || "manual_sms",
          manualSmsOperationId: operation._id,
        },
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  const mutedConversation = await Conversation.findOneAndUpdate(
    { _id: conversation._id, business: business._id },
    {
      $set: {
        aiEnabled: false,
        humanTakeover: true,
        humanTakeoverAt: new Date(),
        humanTakeoverBy: actorId,
        "orchestration.phase": "human_takeover",
        lastMessage: operation.metadata?.providerBody || operation.body,
        lastMessageAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );

  operation.state = "completed";
  operation.message = message._id;
  operation.completedAt = new Date();
  operation.failureCode = "";
  operation.failureMessage = "";
  await operation.save();

  SocketService.emitMessageCreated(business._id, message);
  SocketService.emitConversationUpdated(business._id, mutedConversation);
  SocketService.emitDashboardRefresh(business._id, "manual_sms_sent");
  return { operation, message, conversation: mutedConversation, accepted: true, completed: true };
};

export const executeManualSmsOperation = async ({
  business,
  actorId = null,
  to,
  body,
  conversationId,
  operationId,
  source = "manual_sms",
  directResponse,
}) => {
  if (!business?._id) {
    const error = new Error("An active business subscription is required.");
    error.code = "BUSINESS_REQUIRED";
    error.statusCode = 403;
    throw error;
  }
  const policy = await evaluateManualSmsPolicy({ business, to, body, conversationId });
  if (!policy.allowed) {
    return {
      accepted: false,
      completed: false,
      blocked: true,
      statusCode: policy.statusCode || 400,
      reason: policy.reason,
      message: policy.message || "Manual SMS is not permitted.",
    };
  }
  if (!policy.conversation) {
    return {
      accepted: false,
      completed: false,
      blocked: true,
      statusCode: 409,
      reason: "conversation_required",
      message: "Open the customer's conversation before sending a manual SMS.",
    };
  }

  const operation = await claimOperation({
    business,
    conversation: policy.conversation,
    lead: policy.lead,
    actorId,
    operationId,
    to: policy.normalizedTo,
    body: policy.body,
    source,
  });
  if (operation.state === "blocked") {
    const retryablePolicyBlock =
      ["outside_send_window", "recipient_local_time_unavailable", "communication_usage_limit"].includes(
        operation.failureCode,
      ) || /_limit$/.test(String(operation.failureCode || ""));
    if (retryablePolicyBlock) {
      operation.state = "created";
      operation.failureCode = "";
      operation.failureMessage = "";
      await operation.save();
    } else {
      return responseFromOperation(operation);
    }
  }
  if (operation.state === "completed") {
    return responseFromOperation(operation);
  }
  if (
    ["provider_accepted", "reconciliation_required"].includes(operation.state) &&
    operation.providerMessageId
  ) {
    try {
      return await persistAcceptedOperation({
        operation,
        business,
        conversation: policy.conversation,
        lead: policy.lead,
        actorId,
      });
    } catch (error) {
      operation.state = "reconciliation_required";
      operation.failureCode = String(error?.code || error?.name || "persistence_error");
      operation.failureMessage = String(error?.message || error).slice(0, 1000);
      await operation.save().catch(() => {});
      throw error;
    }
  }
  if (
    ["dispatching", "reconciliation_required"].includes(operation.state) &&
    !operation.providerMessageId
  ) {
    const reconciled = await reconcileDispatchingOperation({ operation, business });
    if (reconciled.accepted) {
      return persistAcceptedOperation({
        operation,
        business,
        conversation: policy.conversation,
        lead: policy.lead,
        actorId,
      });
    }
    if (!reconciled.retryable) {
      return {
        operation,
        accepted: false,
        completed: false,
        pending: true,
        statusCode: 202,
        message:
          operation.state === "reconciliation_required"
            ? operation.failureMessage
            : "This manual SMS operation is already being processed.",
      };
    }
  }

  operation.state = "dispatching";
  operation.lastAttemptAt = new Date();
  await operation.save();
  try {
    const sent = await sendSms({
      business,
      businessId: business._id,
      from: policy.conversation.replyFromPhone || business.phone,
      to: policy.normalizedTo,
      body: policy.body,
      actorId,
      actorType: "user",
      source,
      usageCategory: "manual_sms",
      conversationId: policy.conversation._id,
      leadId: policy.lead?._id || policy.conversation.lead || null,
      directResponse: directResponse ?? policy.directResponse,
      metadata: {
        idempotencyKey: communicationOperationKey(business._id, operation.operationId),
        manualSmsOperationId: String(operation._id),
      },
    });
    if (sent?.suppressed) {
      operation.state = "blocked";
      operation.providerStatus = sent.status || "blocked";
      operation.failureCode = sent.reason || "sms_blocked";
      operation.failureMessage = sent.policyBlocked
        ? "Manual SMS was blocked by policy."
        : "Manual SMS was suppressed because the customer opted out.";
      await operation.save();
      return {
        operation,
        accepted: false,
        completed: false,
        blocked: true,
        statusCode: sent.policyBlocked ? 429 : 409,
        reason: sent.reason,
        message: operation.failureMessage,
        sent,
      };
    }
    operation.state = "provider_accepted";
    operation.providerMessageId = sent?.sid || "";
    operation.providerStatus = sent?.status || "sent";
    operation.metadata = { ...operation.metadata, providerBody: sent?.body || operation.body };
    await operation.save();
    return await persistAcceptedOperation({
      operation,
      business,
      conversation: policy.conversation,
      lead: policy.lead,
      actorId,
    });
  } catch (error) {
    if (error?.providerMessageId) {
      operation.providerMessageId = error.providerMessageId;
      operation.metadata = { ...operation.metadata, providerBody: error.providerBody || operation.body };
    }
    const providerAccepted = Boolean(operation.providerMessageId);
    const providerUncertain = Boolean(error?.deliveryUncertain);
    operation.state =
      providerAccepted || providerUncertain ? "reconciliation_required" : "failed";
    operation.failureCode = String(error?.code || error?.name || "manual_sms_failed").slice(0, 160);
    operation.failureMessage = String(error?.message || error).slice(0, 1000);
    await operation.save().catch((persistError) =>
      logOperationalError("manual_sms.operation_failure_persist_failed", persistError, {
        operationId: operation._id,
      }),
    );
    error.manualSmsOperationId = operation._id;
    error.providerAccepted = providerAccepted;
    error.reconciliationRequired = providerAccepted || providerUncertain;
    throw error;
  }
};

export default { executeManualSmsOperation };
