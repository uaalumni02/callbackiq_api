let ioInstance = null;

const normalizeId = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value._id) {
    return value._id.toString();
  }

  if (typeof value.toString === "function") {
    return value.toString();
  }

  return null;
};

const requireIo = () => {
  if (!ioInstance) {
    console.warn(
      "Socket service attempted to emit before Socket.IO was initialized.",
    );

    return null;
  }

  return ioInstance;
};

class SocketService {
  static initialize(io) {
    if (!io) {
      throw new Error(
        "A valid Socket.IO server instance is required for initialization.",
      );
    }

    ioInstance = io;

    return ioInstance;
  }

  static getIo() {
    return ioInstance;
  }

  static isInitialized() {
    return Boolean(ioInstance);
  }

  static emitToBusiness(businessId, eventName, payload = null) {
    const io = requireIo();
    const normalizedBusinessId = normalizeId(businessId);

    if (!io || !normalizedBusinessId || !eventName) {
      return false;
    }

    io.to(`business:${normalizedBusinessId}`).emit(eventName, payload);

    return true;
  }

  static emitToUser(userId, eventName, payload = null) {
    const io = requireIo();
    const normalizedUserId = normalizeId(userId);

    if (!io || !normalizedUserId || !eventName) {
      return false;
    }

    io.to(`user:${normalizedUserId}`).emit(eventName, payload);

    return true;
  }

  static emitToAdmins(eventName, payload = null) {
    const io = requireIo();

    if (!io || !eventName) {
      return false;
    }

    io.to("role:admin").emit(eventName, payload);

    return true;
  }

  static emitDashboardRefresh(businessId, reason = "data_changed") {
    return this.emitToBusiness(businessId, "dashboard:refresh", {
      reason,
      occurredAt: new Date().toISOString(),
    });
  }

  static emitLeadCreated(businessId, lead) {
    return this.emitToBusiness(businessId, "lead:created", lead);
  }

  static emitLeadUpdated(businessId, lead) {
    return this.emitToBusiness(businessId, "lead:updated", lead);
  }

  static emitConversationCreated(businessId, conversation) {
    return this.emitToBusiness(
      businessId,
      "conversation:created",
      conversation,
    );
  }

  static emitConversationUpdated(businessId, conversation) {
    return this.emitToBusiness(
      businessId,
      "conversation:updated",
      conversation,
    );
  }

  static emitMessageCreated(businessId, message) {
    return this.emitToBusiness(businessId, "message:created", message);
  }

  static emitMessageUpdated(businessId, message) {
    return this.emitToBusiness(businessId, "message:updated", message);
  }

  static emitCallCreated(businessId, callLog) {
    return this.emitToBusiness(businessId, "call:created", callLog);
  }

  static emitCallUpdated(businessId, callLog) {
    return this.emitToBusiness(businessId, "call:updated", callLog);
  }

  static emitAlertCreated(businessId, alert) {
    return this.emitToBusiness(businessId, "alert:created", alert);
  }

  static emitAlertUpdated(businessId, alert) {
    return this.emitToBusiness(businessId, "alert:updated", alert);
  }

  static emitAlertDeleted(businessId, alertId) {
    return this.emitToBusiness(businessId, "alert:deleted", {
      alertId: normalizeId(alertId),
      deletedAt: new Date().toISOString(),
    });
  }

  static emitAllAlertsRead(businessId, payload = {}) {
    return this.emitToBusiness(businessId, "alerts:all_read", {
      ...payload,
      readAt: payload.readAt || new Date().toISOString(),
    });
  }

  static emitConversationIntelligenceUpdated(businessId, intelligence) {
    return this.emitToBusiness(
      businessId,
      "conversation-intelligence:updated",
      intelligence,
    );
  }

  static emitConversationIntelligenceDeleted(businessId, conversationId) {
    return this.emitToBusiness(
      businessId,
      "conversation-intelligence:deleted",
      {
        conversationId,
        deletedAt: new Date().toISOString(),
      },
    );
  }

  static reset() {
    ioInstance = null;
  }
}

export default SocketService;
