import {RELEASE_REVIEW_NEEDED,recordReleaseReview,reconcileReleaseReviews} from './trackingNumberReleaseReview.service.js';
import crypto from 'node:crypto';
import Business from '../models/business.js';
import Intent from '../models/trackingNumberReleaseIntent.js';
import Subscription from '../models/subscription.js';
import { conditionalWrite } from './database/conditionalWrite.js';
import { getSubscriptionAccess, ACCESS_LEVELS } from './subscriptionAccess.service.js';
import { removeProviderNumber, inspectProviderNumber } from '../integrations/phoneNumberOperations.js';
import { logOperationalError } from '../helpers/logging/safeLogger.js';
import { withTrackingNumberOperation, assertTrackingClaim, writeTrackingState,
  loadTrackingBusiness, trackingError } from './trackingNumberState.service.js';

const unresolved = ['pending','dispatching','uncertain'];
const intentSelect = '+providerSid +providerAccountSid +claimToken +authorization.subscription.stripeSubscriptionId';
const uncertain = () => trackingError('TRACKING_NUMBER_RELEASE_UNCERTAIN',
  'The exact provider release outcome requires reconciliation. No replacement or repeat deletion was attempted.', 503);
const equal = (left, right) => left instanceof Date || right instanceof Date
  ? new Date(left).getTime() === new Date(right).getTime() : String(left ?? '') === String(right ?? '');

async function authorizationCurrent(business, authorization) {
  if (authorization.kind === 'administrative') return true; // Privileged compatibility entry, never owner HTTP input.
  if (authorization.kind === 'business_deletion') return business.accountLifecycle?.status === 'deleting' &&
    equal(business.accountLifecycle.deletionStartedAt,authorization.deletionStartedAt);
  const observed = authorization.subscription;
  if (!observed) return false;
  const current = await Subscription.findOne({ _id: observed.subscriptionId, business: business._id });
  return Boolean(current && ['status','stripeSubscriptionId','trialEndsAt','trialNumberReleaseAt']
    .every(field => equal(current[field],observed[field])) && current.trialNumberReleaseAt &&
    current.trialNumberReleaseAt <= new Date() && getSubscriptionAccess(current).level !== ACCESS_LEVELS.FULL);
}

async function changeIntent(intent, changes) {
  const result = await conditionalWrite({ model: Intent, identity: { _id: intent._id, business: intent.business },
    observed: { status: intent.status, claimGeneration: intent.claimGeneration, claimToken: intent.claimToken },
    update: { $set: changes }, select: intentSelect });
  if (!result.applied) throw uncertain();
  return result.current;
}

/** Recording a known purchased SID is safe even when its caller lost the lease. */
export async function planUnattachedNumberRelease({ business, providerSid, accountSid }) {
  const revision = business.trackingNumber?.revision || 0;
  const id = crypto.createHash('sha256').update(`${business._id}:${providerSid}:${revision}:orphan_cleanup`).digest('hex');
  try {
    return await Intent.create({ _id:id, schemaVersion:1, business:business._id, provider:'twilio',
      providerAccountSid:accountSid, providerSid, resourceRole:'unattached', observedRevision:revision, claimRevision:revision,
      authorization:{kind:'orphan_cleanup'}, status:'pending', claimGeneration:0, claimToken:'' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await Intent.findOne({ business:business._id, providerSid, status:{$in:unresolved} }).select(intentSelect);
    if (!existing) throw uncertain();
    return existing;
  }
}

async function reserveIntent(business, authorization, accountSid, targetProviderSid) {
  const scope = await assertTrackingClaim();
  let intent = await Intent.findOne({ business:business._id, status:{$in:unresolved},
    ...(targetProviderSid ? {providerSid:targetProviderSid} : {}) }).sort({createdAt:1}).select(intentSelect);
  // A queued reconciliation row can become obsolete while waiting for a claim.
  // It can never authorize planning a release for a different current SID.
  if (!intent && targetProviderSid) return null;
  if (!intent) {
    const sid = business.trackingNumber?.providerSid;
    if (!sid) return null;
    const revision = business.trackingNumber.revision;
    const id = crypto.createHash('sha256').update(`${business._id}:${sid}:${revision}:${authorization.kind}`).digest('hex');
    try {
      intent = await Intent.create({ _id:id, schemaVersion:1, business:business._id, provider:'twilio',
        providerAccountSid:accountSid, providerSid:sid, observedRevision:revision, claimRevision:revision,
        authorization, status:'pending', claimGeneration:0, claimToken:'' });
    } catch (error) {
      if (error.code !== 11000) throw error;
      intent = await Intent.findOne({ business:business._id, status:{$in:unresolved} }).select(intentSelect);
      if (!intent) throw uncertain();
    }
  }
  if (intent.providerAccountSid !== accountSid) throw uncertain();
  return changeIntent(intent,{ claimGeneration:intent.claimGeneration+1, claimToken:scope.lease.token,
    claimExpiresAt:scope.lease.expiresAt, claimRevision:business.trackingNumber.revision });
}

const releaseChanges = () => ({ $unset:{phone:1,phoneLookup:1}, $set:{
  'messagingCompliance.smsReady':false, 'messagingCompliance.senderAttached':false,
  'messagingCompliance.senderAttachedAt':null, 'messagingCompliance.lastCheckedAt':new Date(),
  'trackingNumber.status':'unassigned', 'trackingNumber.provider':'twilio', 'trackingNumber.providerSid':'',
  'trackingNumber.assignedAt':null, 'trackingNumber.verifiedAt':null, 'trackingNumber.activatedAt':null,
  'trackingNumber.lastError':'', 'trackingNumber.updatedAt':new Date(),
  'setupProgress.trackingNumberAssigned':false, 'setupProgress.trackingNumberVerified':false,
  'setupProgress.trackingNumberActive':false, 'setupProgress.updatedAt':new Date(),
} });

async function finishRelease(business,intent,evidence) {
  await assertTrackingClaim();
  if (intent.resourceRole === 'unattached') {
    await changeIntent(intent,{status:'completed',providerOutcome:evidence==='removed'?'removed':'absent',
      completedAt:new Date(),reconciledAt:new Date(),lastErrorCode:''});
    return {outcome:'released_unattached',business:await loadTrackingBusiness(business._id),intentId:intent._id};
  }
  const sameSid = business.trackingNumber?.providerSid === intent.providerSid;
  const noNumber = !business.trackingNumber?.providerSid && !business.phone;
  if (!sameSid && !noNumber) {
    await changeIntent(intent,{status:'superseded',providerOutcome:'absent',reconciledAt:new Date()});
    return {outcome:'superseded',business:await loadTrackingBusiness(business._id),intentId:intent._id};
  }
  const result = sameSid ? await writeTrackingState(business,releaseChanges()) : {applied:true,current:business};
  if (!result.applied) {
    if (result.current?.trackingNumber?.providerSid === intent.providerSid) throw uncertain();
    await changeIntent(intent,{status:'superseded',providerOutcome:'absent',reconciledAt:new Date()});
    return {outcome:'superseded',business:result.current,intentId:intent._id};
  }
  const needsReview=intent.authorization.kind==='trial_expiry' && !await authorizationCurrent(result.current,intent.authorization);
  const completed=await changeIntent(intent,{status:'completed',providerOutcome:evidence==='removed'?'removed':'absent',
    completedAt:new Date(),reconciledAt:new Date(),lastErrorCode:needsReview?RELEASE_REVIEW_NEEDED:''});
  if(needsReview)await recordReleaseReview(completed);
  return {outcome:needsReview?'released_requires_review':sameSid?'released':'already_released',business:result.current,intentId:intent._id};
}

async function reconcileRelease(business,intent,client) {
  const result = await inspectProviderNumber(client,intent.providerSid);
  if (result.outcome === 'absent') return finishRelease(business,intent,result.evidence);
  await changeIntent(intent,{status:'uncertain',providerOutcome:result.outcome==='present'?'present':'unknown',
    reconciledAt:new Date(),lastErrorCode:result.errorCode || 'PROVIDER_RELEASE_STILL_UNCERTAIN'});
  throw uncertain();
}

async function recordUncertainCompletion(intent,error) {
  // Never reload a successor and adopt its token to complete this older work.
  await conditionalWrite({model:Intent,identity:{_id:intent._id,business:intent.business},
    observed:{status:'dispatching',claimGeneration:intent.claimGeneration,claimToken:intent.claimToken},
    update:{$set:{status:'uncertain',lastErrorCode:error.code || 'RELEASE_RECEIPT_UNKNOWN'}}});
}

async function dispatchRelease(business,intent,client) {
  const eligible = intent.resourceRole === 'unattached'
    ? !await Business.exists({'trackingNumber.providerSid':intent.providerSid})
    : await authorizationCurrent(business,intent.authorization);
  if (!eligible) {
    await changeIntent(intent,{status:'superseded',lastErrorCode:'RELEASE_AUTHORIZATION_CHANGED'});
    return {outcome:'superseded',business:await loadTrackingBusiness(business._id),intentId:intent._id};
  }
  await assertTrackingClaim();
  intent = await changeIntent(intent,{status:'dispatching',dispatchedAt:new Date()});
  const result = await removeProviderNumber(client,intent.providerSid);
  if (result.outcome === 'absent') return finishRelease(business,intent,result.evidence);
  await changeIntent(intent,{status:result.outcome==='rejected'?'pending':'uncertain',
    providerOutcome:result.outcome==='rejected'?'rejected':'unknown',lastErrorCode:result.errorCode});
  if (result.outcome === 'rejected') throw trackingError('TRACKING_NUMBER_RELEASE_REJECTED','Provider rejected the release.',503);
  throw uncertain();
}

/** Durable plan → fenced dispatch → receipt/reconciliation; uncertain work never redispatches. */
export async function releaseTrackingNumberWithReceipt(businessOrId,{client,clientFactory,accountSid,targetProviderSid,
  authorization={kind:'administrative'}}) {
  return withTrackingNumberOperation(businessOrId,'release',async business => {
    const needsProvider = business.trackingNumber?.providerSid || await Intent.exists({business:business._id,status:{$in:unresolved}});
    const provider = needsProvider ? client || clientFactory?.() : null;
    const intent = await reserveIntent(business,authorization,accountSid,targetProviderSid);
    if (!intent) {
      if (targetProviderSid) return {outcome:'superseded',business,intentId:null};
      if (business.phone) throw trackingError('TRACKING_NUMBER_STATE_INCONSISTENT','A stored phone needs provider identity reconciliation.');
      return {outcome:'already_released',business,intentId:null};
    }
    try {
      return intent.status==='pending' ? await dispatchRelease(business,intent,provider) : await reconcileRelease(business,intent,provider);
    } catch (error) {
      await recordUncertainCompletion(intent,error);
      if (error.code==='TRACKING_NUMBER_RELEASE_REJECTED') throw error;
      throw uncertain();
    }
  });
}

/** Bounded recovery also covers active businesses' known orphan-number cleanups. */
export async function reconcileTrackingNumberReleases({clientFactory,accountSid,limit=50,now=new Date()}) {
  const rows = await Intent.find({status:{$in:unresolved},$or:[{claimExpiresAt:null},{claimExpiresAt:{$lte:now}}]})
    .sort({updatedAt:1,_id:1}).limit(Math.min(200,Math.max(1,Math.floor(limit)||50)))
    .maxTimeMS(5000).select('+providerSid').lean();
  const result = {examined:rows.length,completed:0,uncertain:0,failed:0};
  await reconcileReleaseReviews(limit);
  for (const row of rows) {
    try {
      await releaseTrackingNumberWithReceipt(row.business,{clientFactory,accountSid,targetProviderSid:row.providerSid});
      result.completed += 1;
    } catch (error) {
      if (error.code==='TRACKING_NUMBER_RELEASE_UNCERTAIN') result.uncertain += 1; else result.failed += 1;
      logOperationalError('tracking_number.release_reconciliation_deferred',error,
        {businessId:row.business,operationId:row._id,code:error.code || 'RELEASE_RECONCILIATION_FAILED'});
    }
  }
  return result;
}
