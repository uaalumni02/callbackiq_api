import Business from '../models/business.js';
import Subscription from '../models/subscription.js';
import {conditionalWrite} from './database/conditionalWrite.js';
import {getSubscriptionAccess,ACCESS_LEVELS} from './subscriptionAccess.service.js';

/** Subscription owns entitlement; Business fields are projections, never authority.
 * The transactional revision write prevents a read-only snapshot from committing
 * an obsolete Business projection after a concurrent subscription update.
 * Requires the same replica-set capability as trial redemption. No fallback.
 */
export async function projectCurrentEntitlement(businessId) {
 return Subscription.db.transaction(async session=>{
  const current=await Subscription.findOne({business:businessId}).session(session);
  if(!current)return false;
  const acquired=await conditionalWrite({model:Subscription,identity:{_id:current._id,business:businessId},
   observed:{status:current.status,trialEndsAt:current.trialEndsAt,
    stripeSubscriptionId:current.stripeSubscriptionId,isActive:current.isActive,__v:current.__v},
   update:{$inc:{__v:1}},session});
  if(!acquired.applied)throw Object.assign(new Error('Entitlement changed; reload before projecting.'),{code:'ENTITLEMENT_STATE_CHANGED'});
  const activated=getSubscriptionAccess(current).level===ACCESS_LEVELS.FULL;
  await Business.updateOne({_id:businessId},{$set:{'trialCostControls.enabled':activated&&current.status==='trialing',
   'setupProgress.subscriptionActivated':activated,'setupProgress.updatedAt':new Date()}},{session,runValidators:true});
  return activated;
 });
}
