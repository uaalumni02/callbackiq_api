import { Conversation, Db, Response, getBusinessForOwner, getReferenceId, isCurrentAdminRequest, mongoose } from './context.js';

export default class ConversationAccessController {
static async getAuthorizedConversation(
    req,
    res,
    deniedMessage,
    { readOnly = false } = {},
  ) {
    const requesterId = req.user?.userId;
    const { id } = req.params;

    if (!requesterId) {
      Response.responseBadAuth(res, "Not authenticated");
      return null;
    }

    if (!mongoose.isValidObjectId(id)) {
      Response.responseInvalidInput(res, "Invalid conversation ID");
      return null;
    }

    /*
     * Preserve the existing fresh-admin authorization semantics while
     * optimizing only the read/database path in this change.
     */
    const currentAdmin = await isCurrentAdminRequest(req);

    /*
     * For the read-only owner path, Business is already resolved by
     * subscription middleware. Keep lead/archive population for API
     * compatibility, but skip the redundant Business populate.
     *
     * Write/admin paths retain the historical fully-populated behavior.
     */
    const conversation = await Db.getConversationById(
      Conversation,
      id,
      readOnly && !currentAdmin
        ? {
            populateBusiness: false,
            populateLead: true,
            populateArchivedBy: true,
            lean: true,
          }
        : undefined,
    );

    if (!conversation) {
      Response.responseInvalidInput(res, "Conversation not found");
      return null;
    }

    const conversationBusinessReference =
      conversation.business?._id || conversation.business;

    const conversationBusinessId = getReferenceId(
      conversationBusinessReference,
    );

    if (currentAdmin) {
      return {
        requesterId,
        conversation,
        business: null,
        businessId: conversationBusinessReference,
        isAdmin: true,
      };
    }

    const business =
      req.business ||
      (await getBusinessForOwner(requesterId));

    if (!business) {
      Response.responseInvalidInput(res, "Business not found");
      return null;
    }

    if (conversationBusinessId !== getReferenceId(business)) {
      Response.responseBadAuth(res, deniedMessage);
      return null;
    }

    const responseConversation =
      readOnly
        ? {
            ...conversation,
            business: {
              _id: business._id,
              businessName: business.businessName,
              phone: business.phone,
              owner: business.owner,
            },
          }
        : conversation;

    return {
      requesterId,
      conversation: responseConversation,
      business,
      businessId: business._id,
      isAdmin: false,
    };
  }
}
