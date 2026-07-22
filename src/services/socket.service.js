let ioInstance = null;
let uninitializedWarningShown = false;

const normalizeId = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim();

    return normalizedValue || null;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  /*
   * MongoDB and Mongoose ObjectId instances expose toHexString().
   *
   * This check must happen before reading value._id. Mongoose ObjectId has an
   * _id getter that returns the same ObjectId instance. Recursing into that
   * value causes "Maximum call stack size exceeded".
   */
  if (typeof value?.toHexString === "function") {
    const hexadecimalValue = value.toHexString();

    return typeof hexadecimalValue === "string" && hexadecimalValue.trim()
      ? hexadecimalValue.trim()
      : null;
  }

  /*
   * Handle populated Mongoose documents and plain objects containing an ID.
   * Only recurse when the nested ID is a different object/value.
   */
  if (typeof value === "object") {
    const nestedId = value._id ?? value.id ?? null;

    if (nestedId !== null && nestedId !== undefined && nestedId !== value) {
      return normalizeId(nestedId);
    }
  }

  if (typeof value?.toString === "function") {
    const normalizedValue = value.toString().trim();

    if (normalizedValue && normalizedValue !== "[object Object]") {
      return normalizedValue;
    }
  }

  return null;
};

const normalizeEventName = (eventName) => {
  if (typeof eventName !== "string") {
    return null;
  }

  const normalizedEventName = eventName.trim();

  return normalizedEventName || null;
};

const requireIo = () => {
  if (!ioInstance) {
    if (!uninitializedWarningShown) {
      uninitializedWarningShown = true;

      console.warn(
        "Socket service attempted to emit before Socket.IO was initialized.",
      );
    }

    return null;
  }

  return ioInstance;
};

const emitToRoom = (roomName, eventName, payload) => {
  const io = requireIo();
  const normalizedEventName = normalizeEventName(eventName);

  if (!io || !roomName || !normalizedEventName) {
    return false;
  }

  io.to(roomName).emit(normalizedEventName, payload);

  return true;
};

class SocketService {
  static initialize(io) {
    if (!io || typeof io.to !== "function") {
      throw new Error(
        "A valid Socket.IO server instance is required for initialization.",
      );
    }

    ioInstance = io;
    uninitializedWarningShown = false;

    return ioInstance;
  }

  static getIo() {
    return ioInstance;
  }

  static isInitialized() {
    return Boolean(ioInstance);
  }

  static emitToBusiness(businessId, eventName, payload = null) {
    const normalizedBusinessId = normalizeId(businessId);

    if (!normalizedBusinessId) {
      return false;
    }

    return emitToRoom(`business:${normalizedBusinessId}`, eventName, payload);
  }

  static emitToUser(userId, eventName, payload = null) {
    const normalizedUserId = normalizeId(userId);

    if (!normalizedUserId) {
      return false;
    }

    return emitToRoom(`user:${normalizedUserId}`, eventName, payload);
  }

  static emitToAdmins(eventName, payload = null) {
    return emitToRoom("role:admin", eventName, payload);
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
        conversationId: normalizeId(conversationId),
        deletedAt: new Date().toISOString(),
      },
    );
  }

  /*
   * Used by tests and controlled shutdown code. This does not close the actual
   * Socket.IO server; server.js remains responsible for calling io.close().
   */
  static reset() {
    ioInstance = null;
    uninitializedWarningShown = false;
  }
}

export { normalizeId };

export default SocketService;
