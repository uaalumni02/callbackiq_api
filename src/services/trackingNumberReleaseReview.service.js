import Intent from '../models/trackingNumberReleaseIntent.js';
import AlertService from './alert.service.js';
import {conditionalWrite} from './database/conditionalWrite.js';
import {logOperationalError} from '../helpers/logging/safeLogger.js';

export const RELEASE_REVIEW_NEEDED='ENTITLEMENT_CHANGED_DURING_NUMBER_RELEASE';
/** Provider deletion cannot be rolled back by a MongoDB predicate. Retain a
 * durable review obligation until the tenant-scoped operational alert exists. */
export async function recordReleaseReview(intent) {
  try {
    const result=await AlertService.createSystemAlert({businessId:intent.business,actionRequired:true,priority:'high',
      title:'Tracking number needs recovery review',
      message:'Billing changed while a tracking number was being released. The provider confirmed removal. Review number recovery and routing before relying on the original number.',
      metadata:{operationId:intent._id,code:RELEASE_REVIEW_NEEDED},dedupeKey:`number-release-review:${intent._id}`});
    if (!result?.alert?._id) return false;
    const receipt=await conditionalWrite({model:Intent,identity:{_id:intent._id,business:intent.business},
      observed:{status:'completed',lastErrorCode:RELEASE_REVIEW_NEEDED},
      update:{$set:{lastErrorCode:'RELEASE_RECOVERY_REVIEW_RECORDED'}}});
    return receipt.applied;
  } catch (error) {
    logOperationalError('tracking_number.release_review_deferred',error,
      {businessId:intent.business,operationId:intent._id,code:'RELEASE_RECOVERY_REVIEW_PENDING'});
    return false;
  }
}
export async function reconcileReleaseReviews(limit=50) {
  const pending=await Intent.find({status:'completed',lastErrorCode:RELEASE_REVIEW_NEEDED})
    .sort({updatedAt:1,_id:1}).limit(limit).maxTimeMS(5000);
  let recorded=0;
  for (const intent of pending) if(await recordReleaseReview(intent)) recorded+=1;
  return {examined:pending.length,recorded};
}
