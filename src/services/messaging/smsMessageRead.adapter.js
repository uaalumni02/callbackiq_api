// Original message read/fallback contract; database adapter.
export const createSmsMessageReader = ({ Db, Message }) => async (conversationId) =>
  typeof Db.getMessagesForAI === "function"
    ? Db.getMessagesForAI(Message, conversationId)
    : Db.getMessagesByConversation(Message, conversationId);
