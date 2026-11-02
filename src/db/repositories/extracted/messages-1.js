/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbmessages1Methods(deps) {
  const { safeConsole } = deps;
  return {
async getMessagesByConversation(model, conversationId) {
    try {
      return await model
        .find({ conversation: conversationId })
        .sort({ createdAt: 1 })
        .populate("lead", "customerName phone serviceNeeded")
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching messages:", error);
      throw error;
    }
  },

async getMessagesForAI(model, conversationId) {
    const limit = Math.max(20, Math.min(500, Number(process.env.AI_ANALYSIS_HISTORY_LIMIT) || 200));
    const messages = await model.find({ conversation: conversationId })
      .select("_id business conversation lead direction from to body provider providerMessageId status isAiGenerated generatedBy usageCategory actorType actorId metadata createdAt updatedAt")
      .sort({ createdAt: -1, _id: -1 }).limit(limit);
    return messages.reverse();
  },

async getMessageById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("lead", "customerName phone serviceNeeded")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      safeConsole.error("Error fetching message:", error);
      throw error;
    }
  },

async getMessageForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate("lead", "customerName phone serviceNeeded")
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching message for business:", error);
      throw error;
    }
  }
  };
}
