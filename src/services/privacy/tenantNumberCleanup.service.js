import Business from '../../models/business.js';
import TrackingNumber from '../../models/trackingNumber.js';
import {planUnattachedNumberRelease} from '../trackingNumberRelease.service.js';
import {releaseTrackingNumberWithReceipt} from '../trackingNumberProvisioning.service.js';
import {numericSetting} from '../../config/numericSettings.js';
const blocked=code=>Object.assign(new Error('Additional phone-number cleanup must complete before erasure.'),{code,statusCode:503});
/** Releases tenant secondary numbers through durable provider receipts; uncertain or shared ownership blocks erasure. */
export async function releaseTenantSecondaryNumbers(business) {
 const rows=await TrackingNumber.find({business:business._id,providerSid:{$ne:''},status:{$ne:'released'}}).sort({_id:1}).limit(numericSetting('PILOT_DELETION_NUMBER_BATCH')).select('+providerSid');
 for(const number of rows){
  if(await TrackingNumber.exists({business:{$ne:business._id},providerSid:number.providerSid,status:{$ne:'released'}}) || await Business.exists({_id:{$ne:business._id},'trackingNumber.providerSid':number.providerSid}))throw blocked('BUSINESS_DELETION_NUMBER_OWNERSHIP_CONFLICT');
  await planUnattachedNumberRelease({business,providerSid:number.providerSid,accountSid:process.env.TWILIO_ACCOUNT_SID});
  const receipt=await releaseTrackingNumberWithReceipt(business._id,{targetProviderSid:number.providerSid});
  if(!['released','already_released','released_unattached'].includes(receipt.outcome))throw blocked('BUSINESS_DELETION_SECONDARY_NUMBER_PENDING');
  await TrackingNumber.updateOne({_id:number._id,business:business._id,providerSid:number.providerSid},{$set:{status:'released',releasedAt:new Date(),voiceEnabled:false,smsEnabled:false,smsReady:false,senderAttached:false}});
 }
 if(await TrackingNumber.exists({business:business._id,providerSid:{$ne:''},status:{$ne:'released'}}))throw blocked('BUSINESS_DELETION_SECONDARY_NUMBERS_REMAIN');
}
