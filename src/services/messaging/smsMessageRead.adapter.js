// Message history capabilities require explicit tenant context.
export const createSmsMessageReader = ({ Db, Message }) => async (conversationId,businessId) =>
  Db.getMessagesForAI(Message,conversationId,businessId);
