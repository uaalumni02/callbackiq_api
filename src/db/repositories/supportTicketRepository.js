import {tenantRepository,tenantContext} from './tenantRepository.js';
import { safeConsole } from "../../helpers/logging/safeLogger.js";

  // ----- Support Ticket methods -----

export async function saveSupportTicket(model,data,businessId){return tenantRepository(model,tenantContext(businessId)).create(data);}

export async function getSupportTicketsByBusiness(model,businessId){return tenantRepository(model,tenantContext(businessId)).list({},{sort:{createdAt:-1}});}

export async function getSupportTicketForBusiness(model,id,businessId){return tenantRepository(model,tenantContext(businessId)).read(id);}

export async function updateSupportTicketForBusiness(model,id,businessId,data){return tenantRepository(model,tenantContext(businessId)).update(id,data);}

export async function closeSupportTicketForBusiness(model,id,businessId){return tenantRepository(model,tenantContext(businessId)).update(id,{$set:{status:'closed',resolvedAt:new Date()}});}

export async function getAllSupportTickets(model, filter = {}) {
    try {
      return await model
        .find(filter)
        .populate("business", "businessName phone email businessType")
        .populate("user", "userName email role")
        .populate("lastUpdatedBy", "userName email role")
        .populate("ticketHistory.admin", "userName email role")
        .sort({ createdAt: -1 })
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching admin support tickets:", error);
      throw error;
    }
  }
