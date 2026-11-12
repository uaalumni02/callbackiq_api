import {OWNER_RESOURCE_POPULATIONS} from '../dbProjectionFields.js';
import {tenantRepository,tenantContext} from '../tenantRepository.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbconversations1Methods() {
  return {
async getConversationsByBusiness(model,businessId) {
    return tenantRepository(model,tenantContext(businessId)).list({}, {sort:{lastMessageAt:-1,createdAt:-1},populate:OWNER_RESOURCE_POPULATIONS.Conversation});
  },



async getConversationForBusiness(model,id,businessId) {
    return tenantRepository(model,tenantContext(businessId)).read(id,{populate:OWNER_RESOURCE_POPULATIONS.Conversation});
  },



async getConversationByBusinessAndPhone(model,businessId,phone) {
    return tenantRepository(model,tenantContext(businessId)).first({customerPhone:phone},{sort:{lastMessageAt:-1,createdAt:-1}});
  }
  };
}
