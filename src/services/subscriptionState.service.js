import Subscription from '../models/subscription.js';
import {conditionalWrite} from './database/conditionalWrite.js';

export const observeSubscriptionState = subscription => subscription && ({status:subscription.status,
 trialEndsAt:subscription.trialEndsAt,stripeSubscriptionId:subscription.stripeSubscriptionId,
 trialNumberReleaseAt:subscription.trialNumberReleaseAt,__v:subscription.__v});
const scalar=value=>value instanceof Date?value.getTime():value??null;
export const subscriptionObservationMatches=(left,right)=>{
 if(!left || !right)return !left&&!right;
 const observed=observeSubscriptionState(left),current=observeSubscriptionState(right);
 return String(left._id)===String(right._id)&&Object.keys(observed).every(key=>scalar(observed[key])===scalar(current[key]));
};
/** Completion cannot upsert over a concurrent creator. An absent observation
 * uses an insert; the unique business index selects the winner. */
export async function completeObservedSubscription({businessId,observed,fields,session}) {
 if(observed)return conditionalWrite({model:Subscription,identity:{_id:observed._id,business:businessId},
  observed:observeSubscriptionState(observed),update:{$set:fields,$inc:{__v:1}},session});
 try {
  const [current]=await Subscription.create([{business:businessId,...fields}],session?{session}:{});
  return {applied:true,current};
 }catch(error){
  if(error.code!==11000)throw error;
  const query=Subscription.findOne({business:businessId});if(session)query.session(session);
  return {applied:false,current:await query};
 }
}

/** Trial redemption rolls back its transaction on a lost observation. */
export async function applyObservedTrial(input) {
 const completion=await completeObservedSubscription(input);
 if(!completion.applied)throw Object.assign(new Error('Subscription changed before trial completion.'),
  {code:'TRIAL_STATE_CHANGED',statusCode:409,current:completion.current});
 return completion.current;
}
