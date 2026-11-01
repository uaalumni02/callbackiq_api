import { resolveAppointmentAttribution } from '../../src/services/scheduling/appointmentAttribution.repository.js';
import Lead from '../../src/models/lead.js';
import CallLog from '../../src/models/callLog.js';

jest.mock('../../src/models/lead.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/models/callLog.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
const businessId='aaaaaaaaaaaaaaaaaaaaaaaa';
const leadId='bbbbbbbbbbbbbbbbbbbbbbbb';
beforeEach(()=>{jest.clearAllMocks();});

test('invalid business identity cannot query attribution records',async()=>{
  await expect(resolveAppointmentAttribution({businessId:'invalid',input:{lead:leadId}})).resolves.toEqual({marketingSource:null,trackingNumber:null,attribution:{}});
  expect(Lead.findOne).not.toHaveBeenCalled(); expect(CallLog.findOne).not.toHaveBeenCalled();
});

test('lead acquisition record wins over later call information',async()=>{
  const lean=jest.fn().mockResolvedValue({firstMarketingSource:'source-1',firstTrackingNumber:'number-1',firstAttribution:{source:'original'}});
  Lead.findOne.mockReturnValue({select:jest.fn().mockReturnValue({lean})});
  await expect(resolveAppointmentAttribution({businessId,input:{lead:leadId}})).resolves.toEqual({marketingSource:'source-1',trackingNumber:'number-1',attribution:{source:'original'}});
  expect(Lead.findOne).toHaveBeenCalledWith({_id:leadId,business:businessId});
  expect(CallLog.findOne).not.toHaveBeenCalled();
});

test('missing lead acquisition uses earliest attributed call, not newest',async()=>{
  Lead.findOne.mockReturnValue({select:jest.fn().mockReturnValue({lean:jest.fn().mockResolvedValue(null)})});
  const sort=jest.fn();
  sort.mockReturnValue({select:jest.fn().mockReturnValue({lean:jest.fn().mockResolvedValue({marketingSource:'earliest',trackingNumber:'t1',attribution:{channel:'ads'}})})});
  CallLog.findOne.mockReturnValue({sort});
  await expect(resolveAppointmentAttribution({businessId,input:{lead:leadId,marketingSource:'later'}})).resolves.toEqual({marketingSource:'earliest',trackingNumber:'t1',attribution:{channel:'ads'}});
  expect(sort).toHaveBeenCalledWith({createdAt:1,_id:1});
});

test('explicit attribution is returned when there is no lead or phone',async()=>{
  await expect(resolveAppointmentAttribution({businessId,input:{marketingSource:'manual',attribution:{channel:'referral'}}})).resolves.toEqual({marketingSource:'manual',trackingNumber:null,attribution:{channel:'referral'}});
  expect(CallLog.findOne).not.toHaveBeenCalled();
});
