import Usage from '../../src/models/communicationUsage.js';
import { reserveSmsUsage, releaseCommunicationUsage } from '../../src/services/communicationUsage.service.js';
jest.mock('../../src/models/communicationUsage.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{createSystemAlert:jest.fn()}}));
const business={_id:'64f000000000000000000001',communicationLimits:{smsCustomerHourly:4,smsCustomerDaily:120,smsBusinessHourly:300,smsBusinessDaily:3000}};
const now=new Date('2026-10-04T17:39:53.932Z');
const send=(smsUsageClass='proactive',extra={})=>reserveSmsUsage({business,customerPhone:'+12025550123',now,smsUsageClass,suppressAlerts:true,...extra});
let rows;
beforeEach(()=>{
 rows=new Map();jest.clearAllMocks();
 Usage.findOneAndUpdate.mockImplementation(async(filter,update)=>{
  const { $or,...identity }=filter;const id=JSON.stringify(identity);const row=rows.get(id)||{_id:id,count:0};
  if(row.count>$or[0].count.$lte)return null;
  row.count+=update.$inc.count;rows.set(id,row);return {...row};
 });
 Usage.updateOne.mockImplementation(async(filter,update)=>{const row=rows.get(filter._id);if(row)row.count=Math.max(0,row.count-update[0].$set.count.$max[1].$subtract[1]);return {acknowledged:true};});
});
test('same customer can continue replying and receive decline after proactive budget exhausts',async()=>{
 for(let i=0;i<4;i++)expect((await send()).allowed).toBe(true);
 expect(await send()).toMatchObject({allowed:false,reason:'customer_hour_sms_outbound_limit',retryAt:new Date('2026-10-04T18:00:00Z')});
 for(let i=0;i<20;i++)expect((await send('reply',{amount:2})).allowed).toBe(true);
 expect((await send('appointment',{amount:3})).allowed).toBe(true);
 expect((await send()).allowed).toBe(false);
});
test('reply and appointment hourly budgets are bounded and separately accounted',async()=>{
 const highDaily={...business,communicationLimits:{...business.communicationLimits,smsCustomerDaily:1000}};
 for(let i=0;i<12;i++)expect((await send('reply',{amount:10,business:highDaily})).allowed).toBe(true);
 expect(await send('reply',{business:highDaily})).toMatchObject({allowed:false,reason:'customer_hour_sms_outbound_reply_limit'});
 for(let i=0;i<8;i++)expect((await send('appointment',{amount:3,business:highDaily})).allowed).toBe(true);
 expect(await send('appointment',{business:highDaily})).toMatchObject({allowed:false,reason:'customer_hour_sms_outbound_appointment_limit'});
});
test('shared customer daily and business limits still apply',async()=>{
 const capped={...business,communicationLimits:{...business.communicationLimits,smsCustomerDaily:3}};
 expect((await send('reply',{business:capped,amount:2})).allowed).toBe(true);
 expect((await send('appointment',{business:capped})).allowed).toBe(true);
 expect(await send('reply',{business:capped})).toMatchObject({allowed:false,reason:'customer_day_sms_outbound_limit',retryAt:new Date('2026-10-05T00:00:00Z')});
 const ownerCapped={...business,_id:'other',communicationLimits:{...business.communicationLimits,smsBusinessHourly:1}};
 expect((await send('reply',{business:ownerCapped})).allowed).toBe(true);
 expect(await send('appointment',{business:ownerCapped})).toMatchObject({allowed:false,reason:'business_hour_sms_outbound_limit'});
});
test('trial daily cost cap remains shared',async()=>{
 const trial={...business,trialCostControls:{enabled:true}};
 for(let i=0;i<10;i++)expect((await send('reply',{business:trial,amount:2})).allowed).toBe(true);
 expect(await send('appointment',{business:trial})).toMatchObject({allowed:false,reason:'customer_day_sms_outbound_limit'});
});
test('provider rejection releases the correct counters for retry',async()=>{
 const reservation=await send('appointment',{amount:3});await releaseCommunicationUsage(reservation);
 expect([...rows.values()].every(row=>row.count===0)).toBe(true);
});
test('a single message larger than a bucket cannot create an over-limit counter',async()=>{
 expect(await send('proactive',{amount:5})).toMatchObject({allowed:false,reason:'customer_hour_sms_outbound_limit'});
 expect([...rows.values()].every(row=>row.count===0)).toBe(true);
});
test('replica-set quota collision unwinds the transaction without issuing rollback writes',async()=>{
 Usage.findOneAndUpdate.mockRejectedValue(Object.assign(new Error('duplicate'),{code:11000}));
 await expect(send('reply',{mongoSession:{}})).rejects.toMatchObject({code:'COMMUNICATION_USAGE_LIMIT',usage:{allowed:false,reason:'business_hour_sms_outbound_limit'}});
 expect(Usage.updateOne).not.toHaveBeenCalled();
});
