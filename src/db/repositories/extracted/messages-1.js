import {numericSetting} from '../../../config/numericSettings.js';
import {OWNER_RESOURCE_POPULATIONS} from '../dbProjectionFields.js';
import {tenantRepository,tenantContext} from '../tenantRepository.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbmessages1Methods() {
  return {
async getMessagesByConversation(model,conversationId,businessId) {
    return tenantRepository(model,tenantContext(businessId)).list({conversation:conversationId},{sort:{createdAt:1},populate:OWNER_RESOURCE_POPULATIONS.Message});
  },

async getMessagesForAI(model,conversationId,businessId) {
    const repo=tenantRepository(model,tenantContext(businessId));
    const limit=numericSetting('AI_ANALYSIS_HISTORY_LIMIT');
    const messages=await repo.list({conversation:conversationId},{
      select:'_id business conversation lead direction from to body provider providerMessageId status isAiGenerated generatedBy usageCategory actorType actorId metadata createdAt updatedAt',
      sort:{createdAt:-1,_id:-1},limit,
    });
    return messages.reverse();
  },



async getMessageForBusiness(model,id,businessId) {
    return tenantRepository(model,tenantContext(businessId)).read(id,{populate:OWNER_RESOURCE_POPULATIONS.Message});
  }
  };
}
