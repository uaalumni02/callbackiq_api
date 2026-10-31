import Conversation from '../../models/conversation.js';

// Same tenant and open-state query, behind a dedicated repository interface.
export async function findBookingConversation({ business, lead, conversation }) {
    if (conversation) return conversation;
    if (!lead?._id) return null;
    return Conversation.findOne({
      business: business._id,
      lead: lead._id,
      status: "open",
    }).sort({ lastMessageAt: -1 });
}
