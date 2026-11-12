import {requestTrialExtension,requireBillingReceipt} from '../../src/integrations/billingOperations.js';
const end=new Date('2026-12-01T12:00:00Z');
const input=()=>({subscriptionId:'sub_contract',trialEndsAt:end,idempotencyKey:'operation-contract'});
const provider=response=>({subscriptions:{update:jest.fn().mockResolvedValue(response)}});
test('a trial extension returns a normalized receipt and sends the exact idempotent provider command',async()=>{
 const client=provider({id:'sub_contract',status:'trialing',trial_end:end.getTime()/1000,items:{data:[{current_period_end:end.getTime()/1000}]}});
 const result=await requestTrialExtension({...input(),client});
 expect(requireBillingReceipt(result)).toEqual({subscriptionId:'sub_contract',trialEndsAt:end,currentPeriodEnd:end});
 expect(client.subscriptions.update).toHaveBeenCalledWith('sub_contract',{trial_end:end.getTime()/1000,proration_behavior:'none'},{idempotencyKey:'operation-contract'});
 expect(Object.isFrozen(result.receipt)).toBe(true);
});
test.each([null,{status:'active'},{status:'trialing',trial_end:1},{id:'sub_foreign',status:'trialing',trial_end:end.getTime()/1000}])('a nonmatching provider receipt %p cannot verify an extension',async remote=>{
 const result=await requestTrialExtension({...input(),client:provider(remote)});
 expect(result).toMatchObject({outcome:'unverified',code:'TRIAL_EXTENSION_UNVERIFIED'});
 expect(()=>requireBillingReceipt(result)).toThrow(/not verified/);
});
test.each([[400,'rejected'],[408,'uncertain'],[500,'uncertain'],[undefined,'uncertain']])('provider failure %p has normalized outcome %s',async(statusCode,outcome)=>{
 const cause=Object.assign(new Error('Synthetic transport diagnostic'),{statusCode,code:'synthetic_provider_code'}),client={subscriptions:{update:jest.fn().mockRejectedValue(cause)}};
 const result=await requestTrialExtension({...input(),client});expect(result).toMatchObject({outcome,code:'synthetic_provider_code'});
 expect(()=>requireBillingReceipt(result)).toThrow('The billing provider operation could not be verified.');
});
test('missing provider capability and invalid command input cannot dispatch',async()=>{
 expect(await requestTrialExtension({...input(),client:{}})).toMatchObject({outcome:'unavailable',code:'STRIPE_NOT_CONFIGURED'});
 const client=provider({});
 expect(await requestTrialExtension({...input(),trialEndsAt:'invalid',client})).toMatchObject({outcome:'rejected',code:'INVALID_BILLING_OPERATION'});
 expect(client.subscriptions.update).not.toHaveBeenCalled();
});
test('missing configuration is normalized before a provider client can escape an SDK error',async()=>{
 const previous=process.env.STRIPE_SECRET_KEY;delete process.env.STRIPE_SECRET_KEY;
 try{expect(await requestTrialExtension(input())).toMatchObject({outcome:'unavailable',code:'STRIPE_NOT_CONFIGURED'});}
 finally{if(previous===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=previous;}
});
