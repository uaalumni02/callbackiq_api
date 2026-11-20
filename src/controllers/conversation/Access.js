import Conversation from "../../models/conversation.js";
import * as Response from "../../helpers/response/response.js";
import { getBusinessForOwner } from "./helpers.js";
import { isCurrentAdminRequest } from "../../helpers/security/current-admin.js";
import mongoose from "mongoose";
import {readTenantResource} from '../shared/tenantResource.js';
import {adminReadById} from '../../db/repositories/privileged/adminRepository.js';

const fullPopulation=[{path:'business',select:'businessName phone owner'},
 {path:'lead',select:'customerName phone serviceNeeded urgency status serviceEligibility'},
 {path:'archivedBy',select:'userName email role'}];

export default class ConversationAccessController {
 static async getAuthorizedConversation(req,res,deniedMessage,{readOnly=false}={}) {
  const requesterId=req.user?.userId,{id}=req.params;
  if(!requesterId){Response.responseBadAuth(res,'Not authenticated');return null;}
  if(!mongoose.isValidObjectId(id)){Response.responseInvalidInput(res,'Invalid conversation ID');return null;}
  const currentAdmin=await isCurrentAdminRequest(req);
  const business=currentAdmin?null:req.business || await getBusinessForOwner(requesterId);
  if(!currentAdmin && !business){Response.responseInvalidInput(res,'Business not found');return null;}
  const populate=readOnly && !currentAdmin?fullPopulation.filter(spec=>spec.path!=='business'):fullPopulation;
  const conversation=currentAdmin
   ? await adminReadById({model:Conversation,id,actorId:requesterId,reason:'ADMIN_CONVERSATION_ACCESS',populate})
   : await readTenantResource({model:Conversation,businessId:business._id,id,res,populate,
      missingMessage:'Conversation not found',deniedMessage});
  if(!conversation){if(currentAdmin)Response.responseInvalidInput(res,'Conversation not found');return null;}
  const reference=conversation.business?._id || conversation.business;
  if(currentAdmin)return {requesterId,conversation,business:null,businessId:reference,isAdmin:true};
  const responseConversation=readOnly?{...conversation,business:{_id:business._id,businessName:business.businessName,
    phone:business.phone,owner:business.owner}}:conversation;
  return {requesterId,conversation:responseConversation,business,businessId:business._id,isAdmin:false};
 }
}
