import {OWNER_RESOURCE_POPULATIONS} from '../dbProjectionFields.js';
import {tenantRepository,tenantContext} from '../tenantRepository.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbcalls1Methods() {
  return {
async getCallLogsByBusiness(model,businessId) {
    return tenantRepository(model,tenantContext(businessId)).list({}, {sort:{createdAt:-1},populate:OWNER_RESOURCE_POPULATIONS.CallLog});
  },



async getCallLogForBusiness(model,id,businessId) {
    return tenantRepository(model,tenantContext(businessId)).read(id,{populate:OWNER_RESOURCE_POPULATIONS.CallLog});
  },



async updateCallLogForBusiness(model,id,businessId,data) {
    return tenantRepository(model,tenantContext(businessId)).update(id,data,{populate:[
      {path:'business',select:'businessName businessType phone smsTemplate estimatedJobValue'},
      {path:'lead',select:'customerName phone serviceNeeded urgency status serviceEligibility'},
      {path:'conversation',select:'customerPhone customerName status'},
    ]});
  },


  };
}
