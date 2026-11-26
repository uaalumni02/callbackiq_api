import { readProviderEntitlement } from "../providerEntitlement.service.js";
/** Suppresses obsolete queued recovery without dispatch; missing records throw for reconciliation. */
export const createRecoveryIntroductionJob =
  ({
    Business,
    Conversation,
    Lead,
    CallLog,
    isBusinessFeatureEnabled,
    deliverRecoveryIntroduction,
    buildMissedCallRecoveryText,
  }) =>
  async (payload) => {
    const [business, conversation, lead, callLog] = await Promise.all([
      Business.findById(payload.businessId),
      Conversation.findOne({
        _id: payload.conversationId,
        business: payload.businessId,
      }),
      Lead.findOne({ _id: payload.leadId, business: payload.businessId }),
      CallLog.findOne({ _id: payload.callLogId, business: payload.businessId }),
    ]);
    if (!(await readProviderEntitlement(payload.businessId)).allowed) return;
    if (!business || !conversation || !lead || !callLog)
      throw Object.assign(new Error("Recovery records unavailable"), {
        code: "RECOVERY_RECORD_MISSING",
      });
    if (callLog.missedCallTextSent && callLog.smsProviderMessageId) return;
    if (
      !business.isActive ||
      !isBusinessFeatureEnabled(business, "missedCallSmsEnabled") ||
      conversation.humanTakeover ||
      conversation.aiEnabled === false ||
      ["closed", "archived"].includes(conversation.status)
    )
      return;
    return deliverRecoveryIntroduction({
      business,
      conversation,
      lead,
      callLog,
      callSid: payload.callSid,
      customerPhone: conversation.customerPhone,
      starterText: buildMissedCallRecoveryText({ business }),
      numberContext: { trackingNumber: { phoneNumber: payload.from } },
      smsEnabled: true,
      smsStatus: "queued",
      strict: true,
    });
  };
