import { readOwnerSettings } from '../../src/services/ownerSettings.service.js';
import { readStaffDeliveryState } from '../../src/services/notifications/recipientPolicy.service.js';
import mongoose from 'mongoose';
function mockModel(name) {
 return class {
  constructor(value){Object.assign(this,value);}
  toObject(){return {...this};}
  static find(filter){mockQueries.push({name,filter});return {session:jest.fn().mockReturnThis(),sort:jest.fn().mockReturnThis(),lean:async()=>mockRows[name]||[]};}
 };
}
let mockRows, mockQueries;
jest.mock('mongoose',()=>({__esModule:true,default:{startSession:jest.fn()}}));
jest.mock('../../src/services/ownerSettingsVoice.service.js',()=>({applyOwnerCallSettings:jest.fn()}));
jest.mock('../../src/services/notifications/recipientPolicy.service.js',()=>({readStaffDeliveryState:jest.fn().mockResolvedValue([])}));
jest.mock('../../src/services/stateTransitions/documents.js',()=>({saveStateDocument:jest.fn()}));
jest.mock('../../src/services/scheduling/appointmentNotification.service.js',()=>({refreshUpcomingAppointmentNotifications:jest.fn()}));
jest.mock('../../src/services/trades/tradeSetup.service.js',()=>({getTradeSetup:jest.fn(()=>({}))}));
jest.mock('../../src/services/scheduling/availabilityWindows.service.js',()=>({validateWindows:jest.fn()}));
jest.mock('../../src/models/business.js',()=>({__esModule:true,default:mockModel('business')}));
jest.mock('../../src/models/serviceOffering.js',()=>({__esModule:true,default:mockModel('services')}));
jest.mock('../../src/models/serviceArea.js',()=>({__esModule:true,default:mockModel('areas')}));
jest.mock('../../src/models/availabilityRule.js',()=>({__esModule:true,default:mockModel('rules')}));
jest.mock('../../src/models/availabilityException.js',()=>({__esModule:true,default:mockModel('exceptions')}));
jest.mock('../../src/models/schedulingPolicy.js',()=>({__esModule:true,default:mockModel('policies')}));
jest.mock('../../src/models/businessOperationsSettings.js',()=>({__esModule:true,default:mockModel('operations')}));
jest.mock('../../src/voice/voicePhone.service.js',()=>({normalizePhoneToE164:jest.fn()}));
jest.mock('../../src/validator/ownerSettings.js',()=>({validateOwnerSection:jest.fn()}));
jest.mock('../../src/voice/voiceRouting.service.js',()=>({normalizeVoiceSettings:jest.fn(()=>({voiceAiEnabled:true}))}));
jest.mock('../../src/services/voiceSettingsVersion.service.js',()=>({recordVoiceSettingsVersion:jest.fn()}));
const ownerBusiness=()=>({_id:'tenant',businessName:'Example HVAC',businessType:'hvac',forwardingPhone:'+14045550100',timezone:'America/New_York',features:{voiceAiEnabled:true,aiBookingEnabled:true,missedCallSmsEnabled:true},customerMessaging:{configured:true,voiceTextsEnabled:true}});
const team=()=>({humanHandoffContacts:[{active:true,phone:'+14045550101'}],emergencyPolicy:{emergencyContactPhone:'+14045550102',emergencyContactEmail:'urgent@example.com'}});
beforeEach(()=>{jest.clearAllMocks();mockQueries=[];mockRows={services:[{name:'Approved HVAC visit',active:true,aiCanBook:true}],areas:[{type:'unrestricted'}],rules:[{dayOfWeek:1,enabled:true,windows:[{startTime:'08:00',endTime:'17:00'}]}],policies:[{aiBookingConfirmationMode:'manual'}],operations:[team()]};});
test.each([
 [{type:'zip_codes',zipCodes:['30303']},true],
 [{type:'zip_codes',zipCodes:[]},false],
 [{type:'radius',centerPostalCode:'30303',radiusMiles:25},true],
 [{type:'radius',centerPostalCode:'',radiusMiles:25},false],
])('H02 service-area readiness is honest for the saved scope %p',async(area,complete)=>{
 mockRows.areas=[area];const snapshot=await readOwnerSettings(ownerBusiness());expect(snapshot.checklist.find(row=>row.section==='services').complete).toBe(complete);
 expect(mockQueries.every(row=>row.filter.business==='tenant')).toBe(true);expect(mongoose.startSession).not.toHaveBeenCalled();
});
test.each([
 [{active:false,phone:'+14045550101'},false],
 [{active:true,email:'dispatch@example.com'},true],
 [{active:true},false],
])('H11 active reachable staff and both urgent channels determine readiness: %p',async(contact,complete)=>{
 mockRows.operations[0].humanHandoffContacts=[contact];const snapshot=await readOwnerSettings(ownerBusiness());expect(snapshot.checklist.find(row=>row.section==='team').complete).toBe(complete);
});
test.each(['emergencyContactPhone','emergencyContactEmail'])('H11 a missing saved urgent %s remains visibly incomplete',async field=>{
 mockRows.operations[0].emergencyPolicy[field]='';const snapshot=await readOwnerSettings(ownerBusiness());expect(snapshot.checklist.find(row=>row.section==='team').complete).toBe(false);
});
test.each([[true,true,'automatic'],[true,false,'approval'],[false,true,'callback']])('H02 booking readiness never implies authorization: enabled=%p authorized=%p',async(enabled,authorized,mode)=>{
 const business=ownerBusiness();business.features.aiBookingEnabled=enabled;mockRows.policies=[{aiBookingConfirmationMode:'auto',automaticConfirmationAuthorized:authorized}];
 expect((await readOwnerSettings(business)).sections.hours.bookingMode).toBe(mode);
});
test('H02 a transaction read does not perform independent delivery queries or mutate its settings',async()=>{
 const before=JSON.stringify(mockRows),session={synthetic:true};const result=await readOwnerSettings(ownerBusiness(),session);expect(result.notificationDelivery).toEqual([]);expect(readStaffDeliveryState).not.toHaveBeenCalled();expect(JSON.stringify(mockRows)).toBe(before);
});

describe('H11 team destinations are validated before database work', () => {
 const { saveOwnerSettings } = require('../../src/services/ownerSettings.service.js');
 const { normalizePhoneToE164 } = require('../../src/voice/voicePhone.service.js');
 const { validateOwnerSection } = require('../../src/validator/ownerSettings.js');

 beforeEach(() => {
  normalizePhoneToE164.mockReset();
  validateOwnerSection.mockReset();
 });

 test.each([
  ['unparseable', 'not-a-phone', null],
  ['empty normalization', 'not-a-phone', ''],
  ['outside the US', '+442070000000', '+442070000000'],
 ])('rejects a %s staff destination before validation or a transaction', async (_label, submitted, normalized) => {
  normalizePhoneToE164.mockReturnValue(normalized);
  await expect(saveOwnerSettings({
   ownerId: 'owner', section: 'team', revision: 'synthetic-revision',
   payload: { humanHandoffContacts: [{ phone: submitted }] },
  })).rejects.toMatchObject({
   statusCode: 400,
   message: 'Enter a valid US mobile number including its area code.',
  });
  expect(normalizePhoneToE164).toHaveBeenCalledWith(submitted);
  expect(validateOwnerSection).not.toHaveBeenCalled();
  expect(mongoose.startSession).not.toHaveBeenCalled();
 });

 test('rejects an invalid urgent destination before database work', async () => {
  normalizePhoneToE164.mockReturnValue(null);
  await expect(saveOwnerSettings({
   ownerId: 'owner', section: 'team', revision: 'synthetic-revision',
   payload: { emergencyPolicy: { emergencyContactPhone: 'invalid', emergencyContactEmail: 'urgent@example.com' } },
  })).rejects.toMatchObject({ statusCode: 400 });
  expect(normalizePhoneToE164).toHaveBeenCalledWith('invalid');
  expect(validateOwnerSection).not.toHaveBeenCalled();
  expect(mongoose.startSession).not.toHaveBeenCalled();
 });

 test.each([
  [
   { humanHandoffContacts: [{ phone: '(404) 555-0100', active: true }] },
   { humanHandoffContacts: [{ phone: '+14045550100', active: true }], emergencyPolicy: { emergencyContactPhone: '' } },
   ['(404) 555-0100'],
  ],
  [
   { emergencyPolicy: { emergencyContactPhone: '(404) 555-0100', emergencyContactEmail: 'urgent@example.com' } },
   { humanHandoffContacts: [], emergencyPolicy: { emergencyContactPhone: '+14045550100', emergencyContactEmail: 'urgent@example.com' } },
   ['(404) 555-0100'],
  ],
  [
   { humanHandoffContacts: [{ email: 'dispatch@example.com', active: true }], emergencyPolicy: {} },
   { humanHandoffContacts: [{ email: 'dispatch@example.com', active: true, phone: '' }], emergencyPolicy: { emergencyContactPhone: '' } },
   [],
  ],
 ])('normalizes saved contact input and propagates validation rejection without database work: %p', async (payload, normalized, phones) => {
  const rejection = new Error('Synthetic section validation rejection');
  normalizePhoneToE164.mockReturnValue('+14045550100');
  validateOwnerSection.mockRejectedValue(rejection);
  await expect(saveOwnerSettings({
   ownerId: 'owner', section: 'team', revision: 'synthetic-revision', payload,
  })).rejects.toBe(rejection);
  expect(validateOwnerSection).toHaveBeenCalledWith('team', normalized);
  expect(normalizePhoneToE164.mock.calls).toEqual(phones.map(phone => [phone]));
  expect(mongoose.startSession).not.toHaveBeenCalled();
 });
});
