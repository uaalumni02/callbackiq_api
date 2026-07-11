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
  /**
   * Stores the Socket.IO server instance.
   *
   * Call this once from server.js after creating the Socket.IO server.
   */
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

  /**
   * Emits an event to every authenticated connection for one business.
   */
  static emitToBusiness(businessId, eventName, payload = null) {
    const io = requireIo();
    const normalizedBusinessId = normalizeId(businessId);

    if (!io || !normalizedBusinessId || !eventName) {
      return false;
    }

    io.to(`business:${normalizedBusinessId}`).emit(eventName, payload);

    return true;
  }

  /**
   * Emits an event to one authenticated user's active connections.
   */
  static emitToUser(userId, eventName, payload = null) {
    const io = requireIo();
    const normalizedUserId = normalizeId(userId);

    if (!io || !normalizedUserId || !eventName) {
      return false;
    }

    io.to(`user:${normalizedUserId}`).emit(eventName, payload);

    return true;
  }

  /**
   * Emits an event to platform administrators.
   */
  static emitToAdmins(eventName, payload = null) {
    const io = requireIo();

    if (!io || !eventName) {
      return false;
    }

    io.to("role:admin").emit(eventName, payload);

    return true;
  }

  /**
   * Tells the frontend that its dashboard metrics should be fetched again.
   *
   * This keeps MongoDB and the existing dashboard endpoint as the source of
   * truth instead of duplicating reporting calculations in every controller.
   */
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

  static emitConversationIntelligenceUpdated(businessId, intelligence) {
    this.emitToBusiness(
      businessId,
      "conversation-intelligence:updated",
      intelligence,
    );
  }

  static emitConversationIntelligenceDeleted(businessId, conversationId) {
    this.emitToBusiness(businessId, "conversation-intelligence:deleted", {
      conversationId,
      deletedAt: new Date().toISOString(),
    });
  }

  /**
   * Mainly useful for tests or controlled server shutdown.
   */
  static reset() {
    ioInstance = null;
  }
}

export default SocketService;
