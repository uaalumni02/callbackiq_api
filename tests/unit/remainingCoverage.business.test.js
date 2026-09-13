jest.mock('../../src/services/serviceEligibility/serviceEligibility.service.js', () => ({ guardServiceRequest: jest.fn() }), { virtual: true });
jest.mock('nodemailer', () => ({ __esModule:true, default:{createTransport:jest.fn()} }));
jest.mock('../../src/models/marketingSource.js',()=>({__esModule:true,default:{find:jest.fn()}}));
jest.mock('../../src/models/callLog.js',()=>({__esModule:true,default:{find:jest.fn()}}));
jest.mock('../../src/models/lead.js',()=>({__esModule:true,default:{aggregate:jest.fn()}}));
import nodemailer from 'nodemailer';
import {sendStaffReviewEmail} from '../../src/helpers/email/mailer.js';
import Booking from '../../src/services/booking/bookingStateMachine.service.js';
import {guardServiceRequest} from '../../src/services/serviceEligibility/serviceEligibility.service.js';
import {nextActionFor,serializeOpportunity} from '../../src/services/ownerExperience.service.js';
import {isVerifiedEstimate} from '../../src/services/valuation/opportunityValue.js';
import {getAttributionReport} from '../../src/services/marketingAttributionReport.service.js';
import Source from '../../src/models/marketingSource.js';
import Call from '../../src/models/callLog.js';
import Lead from '../../src/models/lead.js';
const oldUrl=process.env.CLIENT_URL;const oldEnv=process.env.NODE_ENV;const oldUser=process.env.GMAIL_ADDRESS;const oldPassword=process.env.GMAIL_PASSWORD;
afterEach(()=>{process.env.NODE_ENV=oldEnv; if(oldUser===undefined)delete process.env.GMAIL_ADDRESS;else process.env.GMAIL_ADDRESS=oldUser;if(oldPassword===undefined)delete process.env.GMAIL_PASSWORD;else process.env.GMAIL_PASSWORD=oldPassword;if(oldUrl===undefined)delete process.env.CLIENT_URL;else process.env.CLIENT_URL=oldUrl;});
test('staff email validates URLs and provides safe fallback business name',async()=>{
 const sendMail=jest.fn().mockResolvedValue({messageId:'m1'});nodemailer.createTransport.mockReturnValue({sendMail});
 process.env.NODE_ENV='development';process.env.GMAIL_ADDRESS='test@example.test';process.env.GMAIL_PASSWORD='test-password';process.env.CLIENT_URL='https://app.example.test';
 await sendStaffReviewEmail({email:'owner@example.test',alertId:'a&b',stage:'overdue'});
 expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({subject:expect.stringMatching(/overdue/),text:expect.stringContaining('Your business')}));
 expect(sendMail.mock.calls[0][0].text).toContain('alertId=a%26b');
 process.env.CLIENT_URL='file:///tmp/unsafe';
 expect(()=>sendStaffReviewEmail({email:'owner@example.test',alertId:'a'})).toThrow('Invalid CLIENT_URL');
 expect(sendMail).toHaveBeenCalledTimes(1);
});
test.each(['sms','voice'])('%s booking returns eligibility decision before booking work',async channel=>{
 const result={reply:'Service not offered',intakeReady:false};guardServiceRequest.mockResolvedValue(result);
 const args={business:{features:{aiBookingEnabled:true}},lead:{_id:'lead'},conversation:{status:'open'},customerMessage:'service request',channel};
 expect(await Booking.handleTurn(args)).toEqual({handled:true,result});
 expect(guardServiceRequest).toHaveBeenLastCalledWith(args);
});
const evidence={stage:'not_started',humanTakeover:false,lastError:'',customerAvailabilityCaptured:true,serviceCaptured:true,addressCaptured:true};
test.each([
 [{decision:'unsupported'},'closed',false],
 [{decision:'needs_clarification'},'qualify',false],
 [{decision:'needs_staff_review'},'exception',false],
 [{decision:'needs_staff_review',request:'Roof repair',reason:'scope_uncertain',reviewSubmitted:true},'exception',true],
])('owner workflow respects eligibility %j',(eligibility,kind,actionRequired)=>{
 const action=nextActionFor({business:{features:{}},lead:{serviceEligibility:eligibility},conversation:null,appointment:null,evidence,hasOpenIntervention:false});
 expect(action).toMatchObject({kind,actionRequired,requiresOwner:actionRequired});
 if(eligibility.decision==='needs_staff_review')expect(action.detail).toContain(eligibility.reviewSubmitted?'Customer requested review.':'Awaiting customer permission');
});
test('conversation eligibility takes precedence over stale lead eligibility',()=>{
 expect(nextActionFor({business:{features:{}},lead:{serviceEligibility:{decision:'unsupported'}},conversation:{serviceEligibility:{decision:'needs_clarification'}},appointment:null,evidence,hasOpenIntervention:false})).toMatchObject({kind:'qualify'});
});
test('unsupported work never contributes a verified opportunity estimate',()=>{
 expect(isVerifiedEstimate({estimatedValue:500,valuation:{source:'owner'},serviceEligibility:{decision:'unsupported'}})).toBe(false);
 expect(isVerifiedEstimate({estimatedValue:500,valuation:{source:'owner'}})).toBe(true);
});
test('attribution qualification excludes unsupported work and low or absent scores',async()=>{
 const businessId='507f1f77bcf86cd799439011';const ids=[1,2,3,4].map(n=>`507f1f77bcf86cd79943901${n+1}`);
 Source.find.mockReturnValue({lean:async()=>[{_id:'source',monthlySpend:0}]});
 Call.find.mockReturnValue({lean:async()=>ids.map(lead=>({lead,marketingSource:'source'}))});
 Lead.aggregate.mockResolvedValue([
 {_id:ids[0],leadQualityScore:90,serviceEligibility:{decision:'unsupported'}},
 {_id:ids[1],leadQualityScore:60}, {_id:ids[2],leadQualityScore:59}, {_id:ids[3]},
 ]);
 const [report]=await getAttributionReport({businessId});
 expect(report).toMatchObject({leads:4,qualifiedLeads:1});
 expect(Source.find).toHaveBeenCalledWith(expect.objectContaining({business:businessId}));
});
