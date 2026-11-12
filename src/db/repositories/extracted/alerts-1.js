import {OWNER_RESOURCE_POPULATIONS} from '../dbProjectionFields.js';
import {tenantRepository,tenantContext} from '../tenantRepository.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbalerts1Methods() {
  return {
async getAlertsByBusiness(model,businessId) {
    return tenantRepository(model,tenantContext(businessId)).list({}, {sort:{createdAt:-1},populate:OWNER_RESOURCE_POPULATIONS.Alert});
  },

async getUnreadAlertsByBusiness(model,businessId) {
    return tenantRepository(model,tenantContext(businessId)).list({readAt:null}, {sort:{createdAt:-1},populate:OWNER_RESOURCE_POPULATIONS.Alert});
  },



async getAlertForBusiness(model,id,businessId) {
    return tenantRepository(model,tenantContext(businessId)).read(id,{populate:OWNER_RESOURCE_POPULATIONS.Alert});
  },



async updateAlertForBusiness(model,id,businessId,data) {
    return tenantRepository(model,tenantContext(businessId)).update(id,data,{populate:[{path:'business',select:'businessName businessType phone'},{path:'lead',select:'customerName phone serviceNeeded urgency status serviceEligibility'}]});
  },



async markAlertAsReadForBusiness(model,id,businessId) {
    return tenantRepository(model,tenantContext(businessId)).update(id,{$set:{status:'read',readAt:new Date()}},{populate:[
      {path:'business',select:'businessName businessType phone'},
      {path:'lead',select:'customerName phone serviceNeeded urgency status serviceEligibility'},
    ]});
  },

async markAllAlertsAsRead(model,businessId,readAt=new Date()) {
    return tenantRepository(model,tenantContext(businessId)).updateMany({readAt:null},{$set:{status:'read',readAt}});
  }
  };
}
