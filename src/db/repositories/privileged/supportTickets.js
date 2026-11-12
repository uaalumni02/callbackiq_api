import SupportTicket from '../../../models/supportTicket.js';
import {adminUpdateById} from './adminRepository.js';

const population=Object.freeze([
 {path:'business',select:'businessName phone email businessType'},
 {path:'user',select:'userName email role'},
 {path:'lastUpdatedBy',select:'userName email role'},
 {path:'ticketHistory.admin',select:'userName email role'},
]);
/** A named support command fixes its model, audit purpose and response projection.
 * Generic privilege is checked afresh by the shared administrator boundary. */
export function updateSupportTicketAsAdmin({id,actorId,update}) {
 return adminUpdateById({model:SupportTicket,id,actorId,update,reason:'ADMIN_SUPPORT_UPDATE',populate:population});
}
