import {OWNER_RESOURCE_POPULATIONS} from '../dbProjectionFields.js';
import {tenantRepository,tenantContext} from '../tenantRepository.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbleads1Methods() {
  return {
async getLeadsByBusiness(model,businessId) {
    return tenantRepository(model,tenantContext(businessId)).list({}, {sort:{createdAt:-1},populate:OWNER_RESOURCE_POPULATIONS.Lead});
  },





async updateLeadForBusiness(model,id,businessId,data) {
    return tenantRepository(model,tenantContext(businessId)).update(id,data,{populate:[{path:'business',select:'businessName businessType phone'}]});
  },

async getLeadByBusinessAndPhone(model,businessId,phone) {
    return tenantRepository(model,tenantContext(businessId)).first({phone},{sort:{createdAt:-1}});
  },


  };
}
