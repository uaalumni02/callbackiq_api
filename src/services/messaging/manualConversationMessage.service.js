import { getOwnedBusiness } from "../businessScope.service.js";
import { executeManualSmsOperation } from "./manualSmsOperation.service.js";

const bodyText = (body = {}) =>
  String(body.body || body.content || body.message || "").trim();

export const handleConversationManualMessage = async (req, res, next) => {
  try {
    const business = await getOwnedBusiness({
      user: req.user,
      requestedBusinessId: req.body?.businessId,
    });
    const conversationId =
      req.body?.conversation || req.body?.conversationId || req.params?.conversationId;
    const operationId =
      req.body?.operationId ||
      req.body?.clientOperationId ||
      req.get?.("Idempotency-Key") ||
      req.get?.("X-Idempotency-Key") ||
      "";
    const result = await executeManualSmsOperation({
      business,
      actorId: req.user?.userId || req.user?._id || req.user?.id || null,
      to: req.body?.to || "",
      body: bodyText(req.body),
      conversationId,
      operationId,
      source: "conversation_dashboard",
    });
    if (result.blocked) {
      return res.status(result.statusCode || 409).json({
        success: false,
        message: result.message || "Manual SMS was blocked.",
        code: result.reason || "MANUAL_SMS_BLOCKED",
        data: {
          operationId: result.operation?.operationId || operationId,
          state: result.operation?.state || "blocked",
        },
      });
    }
    if (result.pending) {
      return res.status(202).json({
        success: true,
        message: result.message || "Manual SMS is being reconciled.",
        data: {
          operationId: result.operation?.operationId || operationId,
          state: result.operation?.state || "dispatching",
          pending: true,
        },
      });
    }
    return res.status(result.completed ? 201 : 202).json({
      success: true,
      message: result.completed
        ? "Manual SMS accepted by Twilio and saved."
        : "Manual SMS accepted and awaiting reconciliation.",
      data: result.message || {
        operationId: result.operation?.operationId || operationId,
        state: result.operation?.state,
        providerMessageId: result.operation?.providerMessageId || "",
      },
      operation: {
        id: result.operation?._id,
        operationId: result.operation?.operationId || operationId,
        state: result.operation?.state,
        replayed: Boolean(result.replayed),
      },
    });
  } catch (error) {
    return next(error);
  }
};

export default { handleConversationManualMessage };
