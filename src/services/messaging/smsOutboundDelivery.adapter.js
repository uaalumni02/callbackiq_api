// Verbatim durable outbound processing moved behind dependency injection. Do not reorder provider calls.
export const createSmsOutboundDelivery = ({ Message, Conversation, AlertService, SocketService, sendSms, logOperationalEvent, applySmsProductionInvariants, describeSmsWorkflowDecision, assertDistributedLeaseActive, respectCustomerConstraints, getSmsAutomationSuppressionReason }) => async ({
  business,
  lead,
  conversation,
  inboundMessage,
  result,
}) => {
  result = applySmsProductionInvariants({
    result, business, lead, conversation,
    customerMessage: inboundMessage?.body,
  });
  const workflowDecision = describeSmsWorkflowDecision({ result, conversation });
  assertDistributedLeaseActive();
  await Message.updateOne({ _id: inboundMessage._id, business: business._id },
    { $set: { 'metadata.workflowDecision': workflowDecision } });
  const reply = respectCustomerConstraints(result?.reply, {
    conversation, customerMessage: inboundMessage?.body,
  });
  if (!reply || result?.decision === "no_reply") return { sent: false, reason: "no_reply" };
  assertDistributedLeaseActive();

  const isAiGenerated = result?.guardrail?.skipAI !== true;
  const fixedEmergencyReply = !isAiGenerated && result?.messageCategory === "emergency" &&
    result?.decision === "send_fixed_response";
  const usageCategory =
    result?.messageCategory === "emergency"
      ? "safety"
      : isAiGenerated
        ? "ai_reply"
        : "guardrail_reply";

  let outbound = await Message.findOne({
    business: business._id,
    inReplyToMessage: inboundMessage._id,
  });

  if (outbound?.providerMessageId) {
    return { sent: true, duplicate: true, message: outbound };
  }

  // Suppression is a terminal outcome for this inbound turn, including replay
  // after a worker restart. Never turn a blocked send into uncertain delivery.
  if (outbound?.status === "suppressed") {
    return { sent: false, suppressed: true, duplicate: true, message: outbound };
  }

  if (outbound?.deliveryAttemptedAt && !outbound.providerMessageId) {
    outbound = await Message.findByIdAndUpdate(
      outbound._id,
      {
        status: "failed",
        deliveryUncertain: true,
        deliveryErrorMessage:
          "The worker restarted after the provider send began. Automatic resend was blocked to prevent a duplicate customer message.",
      },
      { returnDocument: "after" },
    );
    await AlertService.createSystemAlert({
      businessId: business._id,
      title: "SMS delivery needs review",
      message:
        "An AI reply may have reached the customer, but CallBackIQ could not confirm the provider result. Review the conversation before sending again.",
      priority: "high",
      metadata: {
        conversationId: String(conversation._id),
        inboundMessageId: String(inboundMessage._id),
        outboundMessageId: String(outbound._id),
      },
      dedupeKey: `sms_delivery_uncertain:${outbound._id}`,
    });
    return { sent: false, reason: "delivery_uncertain", message: outbound };
  }

  if (!outbound) {
    try {
      outbound = await Message.create({
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        direction: "outbound",
        from: conversation.replyFromPhone || business.phone,
        to: conversation.customerPhone,
        body: reply,
        provider: "twilio",
        providerMessageId: "",
        status: "queued",
        isAiGenerated,
        generatedBy: isAiGenerated ? "ai" : "guardrail",
        usageCategory,
        actorType: isAiGenerated ? "ai" : "webhook",
        inReplyToMessage: inboundMessage._id,
        metadata: {
          source: "inbound_sms_reply",
          workflowDecision,
          decision: result?.decision || "reply",
          messageCategory: result?.messageCategory || "unknown",
          handoffRequired: result?.handoff?.required === true,
          handoffReason: result?.handoff?.reason || "",
          handoffStatusAcknowledgement:
            result?.handoff?.statusAcknowledgement === true,
          idempotencyKey: `sms-inbound-reply:${business._id}:${inboundMessage._id}`,
        },
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      outbound = await Message.findOne({
        business: business._id,
        inReplyToMessage: inboundMessage._id,
      });
    }
  }

  assertDistributedLeaseActive();
  const claimed = await Message.findOneAndUpdate(
    {
      _id: outbound._id,
      providerMessageId: "",
      deliveryAttemptedAt: null,
      status: { $in: ["queued", "failed"] },
    },
    {
      $set: {
        status: "queued",
        deliveryAttemptedAt: new Date(),
        deliveryUncertain: false,
        deliveryErrorCode: "",
        deliveryErrorMessage: "",
      },
    },
    { returnDocument: "after" },
  );

  if (!claimed) {
    const latest = await Message.findById(outbound._id);
    return { sent: Boolean(latest?.providerMessageId), duplicate: true, message: latest };
  }

  try {
    assertDistributedLeaseActive();
    const suppressionReason = await getSmsAutomationSuppressionReason({
      businessId: business._id, conversationId: conversation._id,
      leadId: lead._id, to: conversation.customerPhone, isAiGenerated,
      contactControl: result?.contactControl || '', customerMessage: inboundMessage?.body, fixedEmergencyReply,
    });
    if (suppressionReason) {
      outbound = await Message.findByIdAndUpdate(claimed._id, {
        status: "suppressed", deliveryStatus: "suppressed",
        deliveryAttemptedAt: null, deliveryUncertain: false,
        deliveryErrorMessage: suppressionReason,
        metadata: { ...claimed.metadata, suppressionReason },
      }, { returnDocument: "after", runValidators: true });
      SocketService.emitMessageCreated(business._id, outbound);
      logOperationalEvent("twilio.sms.reply_suppressed", { businessId: business._id,
        conversationId: conversation._id, inboundMessageId: inboundMessage._id, reason: suppressionReason });
      if (["automation_context_changed", "automation_context_missing"].includes(suppressionReason)) {
        await AlertService.createSystemAlert({ businessId: business._id,
          title: "Customer SMS reply blocked by record mismatch",
          message: "A prepared reply was not sent because its customer or lead link changed. Review the conversation and respond manually after verifying the recipient.",
          priority: "high", metadata: { conversationId: String(conversation._id), inboundMessageId: String(inboundMessage._id), reason: suppressionReason },
          dedupeKey: `sms_identity_suppressed:${inboundMessage._id}` });
      }
      return { sent: false, suppressed: true, reason: suppressionReason, message: outbound };
    }
    const sent = await sendSms({
      business,
      businessId: business._id,
      from: conversation.replyFromPhone || business.phone,
      to: conversation.customerPhone,
      body: reply,
      actorType: isAiGenerated ? "ai" : "webhook",
      source: "inbound_sms_reply",
      usageCategory,
      conversationId: conversation._id,
      leadId: lead._id,
      directResponse: true,
      bypassUsageLimits:
        result?.handoff?.required === true ||
        result?.handoff?.statusAcknowledgement === true,
      metadata: {
        aiGenerated: isAiGenerated,
        fixedEmergencyReply,
        generatedBy: isAiGenerated ? "ai" : "guardrail",
        decision: result?.decision,
        messageCategory: result?.messageCategory,
        inboundMessageId: String(inboundMessage._id),
        handoffRequired: result?.handoff?.required === true,
        handoffReason: result?.handoff?.reason || "",
        handoffStatusAcknowledgement:
          result?.handoff?.statusAcknowledgement === true,
        idempotencyKey: `sms-inbound-reply:${business._id}:${inboundMessage._id}`,
      },
    });

    const status = sent?.suppressed === true ? "suppressed" : sent?.status || "sent";
    outbound = await Message.findByIdAndUpdate(
      claimed._id,
      {
        providerMessageId: sent?.sid || "",
        ...(sent?.sid && !sent?.suppressed ? { providerAcceptedAt: new Date() } : {}),
        body: sent?.body || reply,
        status,
        deliveryStatus: status,
        ...(sent?.suppressed === true ? { deliveryAttemptedAt: null, deliveryUncertain: false } : {}),
        encoding: sent?.encoding || "",
        segmentCount: sent?.segmentCount || 1,
        deliveryErrorCode: sent?.providerCode ? String(sent.providerCode) : "",
        deliveryErrorMessage: sent?.reason || "",
        metadata: {
          ...claimed.metadata,
          usage: sent?.usage || null,
          suppressionReason: sent?.suppressed ? sent.reason : null,
        },
      },
      { returnDocument: "after", runValidators: true },
    );

    SocketService.emitMessageCreated(business._id, outbound);
    if (sent?.suppressed === true) {
      logOperationalEvent("twilio.sms.reply_suppressed", {
        businessId: business._id,
        reason: sent.reason || "customer_opted_out",
      });
      return { sent: false, suppressed: true, message: outbound };
    }

    const updatedConversation = await Conversation.findByIdAndUpdate(
      conversation._id,
      { lastMessage: sent?.body || reply, lastMessageAt: new Date() },
      { returnDocument: "after" },
    );
    SocketService.emitConversationUpdated(business._id, updatedConversation);
    SocketService.emitDashboardRefresh(business._id, "inbound_sms_reply_sent");
    logOperationalEvent("twilio.sms.reply_sent", {
      businessId: business._id,
      providerMessageId: sent?.sid || "",
      segmentCount: sent?.segmentCount || 1,
    });
    return { sent: true, message: outbound };
  } catch (error) {
    const uncertain = error?.deliveryUncertain === true || [
      "SMS_PROVIDER_OUTCOME_UNCERTAIN",
      "SMS_DELIVERY_RECONCILIATION_REQUIRED",
    ].includes(String(error?.code || ""));
    await Message.findByIdAndUpdate(claimed._id, {
      status: "failed",
      deliveryStatus: "failed",
      deliveryAttemptedAt: uncertain ? claimed.deliveryAttemptedAt || new Date() : null,
      deliveryUncertain: uncertain,
      deliveryErrorCode: String(error?.code || "provider_error"),
      deliveryErrorMessage: String(error?.message || "SMS provider failure").slice(0, 1000),
    });
    if (uncertain) {
      await AlertService.createSystemAlert({
        businessId: business._id,
        title: "SMS provider outcome requires reconciliation",
        message: "CallBackIQ blocked an automatic resend because Twilio may have accepted the reply. Review provider reconciliation before sending again.",
        priority: "high",
        metadata: {
          conversationId: String(conversation._id),
          inboundMessageId: String(inboundMessage._id),
          outboundMessageId: String(claimed._id),
        },
        dedupeKey: `sms_delivery_uncertain:${claimed._id}`,
      });
      return { sent: false, reason: "delivery_uncertain", message: claimed };
    }
    throw error;
  }
};
