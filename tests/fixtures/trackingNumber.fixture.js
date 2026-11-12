import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
export const expectedWebhooks = {
  voiceUrl:'https://api.callbackiq.test/api/twilio/voice#ct=1500&rt=5000&tt=14000&rc=1&rp=ct,rt,5xx',
  voiceFallbackUrl:'https://api.callbackiq.test/api/twilio/voice-fallback#ct=1500&rt=5000&tt=12000&rc=0',
  smsUrl:'https://api.callbackiq.test/api/twilio/sms#ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx',
  smsFallbackUrl:'https://api.callbackiq.test/api/twilio/sms-fallback#ct=1500&rt=5000&tt=12000&rc=0',
  statusCallback:'https://api.callbackiq.test/api/twilio/status#ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx',
};
export function configureTrackingFixture() {
  Object.assign(process.env,{TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000',
    TWILIO_AUTH_TOKEN:'test-auth-token',TWILIO_WEBHOOK_BASE_URL:'https://api.callbackiq.test'});
}
export async function trackingFixture(overrides={}) {
  const business=await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Synthetic tracking contract',
    businessType:'plumbing',email:'tracking@example.test',forwardingPhone:'+14045550999',phone:'+14045550123',
    trackingNumber:{status:'unassigned',providerSid:''},...overrides});
  const subscription=await Subscription.create({business:business._id,status:'active',isActive:true,
    stripeCustomerId:'cus_tracking',stripeSubscriptionId:'sub_tracking'});
  return {business,subscription};
}
export function providerFixture() {
  const incoming={sid:'PN123',phoneNumber:'+14045550123',dateCreated:new Date('2026-08-01T12:00:00Z'),...expectedWebhooks};
  const list=jest.fn().mockResolvedValue([incoming]),update=jest.fn().mockResolvedValue(incoming),
    remove=jest.fn().mockResolvedValue(true),fetch=jest.fn().mockResolvedValue(incoming),create=jest.fn().mockResolvedValue(incoming),
    availableList=jest.fn().mockResolvedValue([{phoneNumber:incoming.phoneNumber}]);
  const incomingPhoneNumbers=jest.fn(()=>({update,remove,fetch}));
  Object.assign(incomingPhoneNumbers,{list,create});
  return {incoming,list,update,remove,fetch,create,availableList,incomingPhoneNumbers,
    client:{incomingPhoneNumbers,availablePhoneNumbers:jest.fn(()=>({local:{list:availableList}}))}};
}
