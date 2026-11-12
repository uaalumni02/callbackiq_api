import {planSubscriptionProjection} from '../../src/helpers/billing/subscriptionProjection.js';
const now=new Date('2026-08-01T12:00:00Z');
const input=overrides=>({remote:{id:'sub_current',status:'active'},current:{stripeCustomerId:'cus_current',priceMonthly:99},
 checkoutSessionId:'cs_current',plan:'pro',now,releaseGraceMs:48*3600000,...overrides});
test('active projection clears release scheduling and retains canonical price and period fields',()=>{
 const result=planSubscriptionProjection(input({remote:{id:'sub_current',status:'active',items:{data:[{current_period_start:1800000000,current_period_end:1801000000,price:{id:'price_live',unit_amount:9900}}]}}}));
 expect(result).toMatchObject({active:true,terminal:false,fields:{isActive:true,aiEnabled:true,stripePriceId:'price_live',priceMonthly:99,
  trialNumberReleaseAt:null,currentPeriodStart:new Date(1800000000000),currentPeriodEnd:new Date(1801000000000)}});
});
test.each(['paused','canceled','unpaid','incomplete_expired'])('terminal %s projection schedules only a used trial and preserves an existing deadline',status=>{
 const args=input({remote:{id:'sub_current',status},current:{trialUsedAt:now}});
 expect(planSubscriptionProjection(args).fields.trialNumberReleaseAt).toEqual(new Date(now.getTime()+48*3600000));
 const held=new Date(now.getTime()+7*86400000);
 expect(planSubscriptionProjection({...args,current:{...args.current,trialNumberReleaseAt:held}}).fields.trialNumberReleaseAt).toEqual(held);
 expect(planSubscriptionProjection({...args,current:{}}).fields.trialNumberReleaseAt).toBeUndefined();
});
test('invoice fields are part of the same planned projection and preserve trial dates omitted by the provider',()=>{
 const trialEnd=new Date('2026-08-10'),result=planSubscriptionProjection(input({current:{trialEndsAt:trialEnd},invoiceProjection:{latestInvoiceId:'in_new',lastPaymentStatus:'paid'}}));
 expect(result.fields).toMatchObject({trialEndsAt:trialEnd,latestInvoiceId:'in_new',lastPaymentStatus:'paid'});
});
