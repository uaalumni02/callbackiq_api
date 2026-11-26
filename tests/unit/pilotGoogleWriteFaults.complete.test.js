import Provider from '../../src/integrations/scheduling/googleCalendar.provider.js';
import {getGoogleConnection,googleApiRequest} from '../../src/services/integrations/googleCalendarConnection.service.js';
import {getGoogleSettings} from '../../src/services/integrations/integrationSettings.service.js';
import {assertGoogleWriteAvailable} from '../../src/integrations/scheduling/googleFinalAvailability.js';
import {invalidateGoogleAvailabilityCache} from '../../src/integrations/scheduling/googleAvailabilitySnapshot.js';
jest.mock('../../src/integrations/scheduling/schedulingProvider.js',()=>({__esModule:true,default:class{constructor({business}){this.business=business;}}}));
jest.mock('../../src/services/integrations/googleCalendarConnection.service.js',()=>({getGoogleConnection:jest.fn(),googleApiRequest:jest.fn(),listGoogleCalendars:jest.fn()}));
jest.mock('../../src/services/integrations/integrationSettings.service.js',()=>({getGoogleSettings:jest.fn()}));
jest.mock('../../src/integrations/scheduling/googleFinalAvailability.js',()=>({assertGoogleWriteAvailable:jest.fn()}));
jest.mock('../../src/integrations/scheduling/googleAvailability.js',()=>({googleAvailability:jest.fn()}));
jest.mock('../../src/integrations/scheduling/googleAvailabilitySnapshot.js',()=>({invalidateGoogleAvailabilityCache:jest.fn()}));
jest.mock('../../src/services/stateTransitions/documents.js',()=>({saveStateDocument:jest.fn()}));
const appointment=()=>({_id:'appointment',business:'tenant',startAt:'2026-12-01T14:00:00Z',endAt:'2026-12-01T15:00:00Z',externalAppointmentId:'event',externalCalendarId:'booking'});
const provider=()=>new Provider({business:{id:'tenant',timezone:'America/New_York'}});
beforeEach(()=>{jest.resetAllMocks();getGoogleConnection.mockResolvedValue({status:'connected',providerCalendarId:'booking'});getGoogleSettings.mockReturnValue({availabilityCalendarIds:['secondary']});assertGoogleWriteAvailable.mockResolvedValue(undefined);googleApiRequest.mockResolvedValue({id:'event'});invalidateGoogleAvailabilityCache.mockResolvedValue(true);});
test.each(['createAppointment','restoreAppointment','updateAppointment'])('B02 %s supports a serialized tenant ID and verifies fresh availability before writing',async method=>{
 await provider()[method]({appointment:appointment(),service:{name:'Inspection'},changeKey:'synthetic-change',changes:{notes:'Owner approved visit'}});
 expect(assertGoogleWriteAvailable).toHaveBeenCalledWith(expect.objectContaining({business:{id:'tenant',timezone:'America/New_York'},bookingCalendarId:'booking',availabilityCalendarIds:['secondary','booking']}));
 const write=googleApiRequest.mock.calls.find(([request])=>['POST','PUT'].includes(request.method));expect(write[0].businessId).toBe('tenant');
 expect(assertGoogleWriteAvailable.mock.invocationCallOrder[0]).toBeLessThan(googleApiRequest.mock.invocationCallOrder[0]);
 expect(invalidateGoogleAvailabilityCache).toHaveBeenCalledWith('tenant');
});
test.each(['createAppointment','restoreAppointment','updateAppointment'])('B02 %s fails closed when final availability fails',async method=>{
 const failure=Object.assign(new Error('availability unavailable'),{code:'GOOGLE_AVAILABILITY_INCOMPLETE'});assertGoogleWriteAvailable.mockRejectedValue(failure);
 await expect(provider()[method]({appointment:appointment(),service:{name:'Inspection'},changes:{},changeKey:'synthetic-change'})).rejects.toBe(failure);
 expect(googleApiRequest).not.toHaveBeenCalled();expect(invalidateGoogleAvailabilityCache).not.toHaveBeenCalled();
});
test('B02 restore refuses an uncertain provider failure and does not invalidate a success cache',async()=>{
 const failure=Object.assign(new Error('synthetic timeout'),{statusCode:503});googleApiRequest.mockRejectedValue(failure);
 await expect(provider().restoreAppointment({appointment:appointment(),changeKey:'synthetic-change'})).rejects.toBe(failure);expect(googleApiRequest).toHaveBeenCalledTimes(1);expect(invalidateGoogleAvailabilityCache).not.toHaveBeenCalled();
});
