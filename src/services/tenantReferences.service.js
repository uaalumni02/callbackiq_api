import mongoose from 'mongoose';
import Lead from '../models/lead.js';
import Conversation from '../models/conversation.js';

export async function assertTenantReferences(businessId, input) {
  for (const [field, Model] of [['lead', Lead], ['conversation', Conversation]]) {
    const id = input[field];
    if (!id) continue;
    if (!mongoose.isValidObjectId(id) || !await Model.exists({ _id: id, business: businessId })) {
      throw Object.assign(new Error(`${field} not found`), { isJoi: true, code: 'INVALID_TENANT_REFERENCE' });
    }
  }
  if (input.lead && input.conversation && !await Conversation.exists({
    _id: input.conversation, business: businessId, lead: input.lead,
  })) {
    throw Object.assign(new Error('Lead and conversation do not belong to the same request'), { isJoi: true });
  }
}
