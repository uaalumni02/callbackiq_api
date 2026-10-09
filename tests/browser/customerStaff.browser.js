/* Real browser + mounted API + ephemeral MongoDB. Only outbound SMS and model
 * understanding are doubled. No purchases, production DB, or live provider calls.
 * Run with npm run test:browser; never included in the hermetic unit tier. */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chromium } from 'playwright';
import app from '../../src/app.js';
import Token from '../../src/helpers/jwt/token.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import CallLog from '../../src/models/callLog.js';
import Message from '../../src/models/message.js';
import Alert from '../../src/models/alert.js';
import Appointment from '../../src/models/appointment.js';
import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import ServiceArea from '../../src/models/serviceArea.js';
import SchedulingPolicy from '../../src/models/schedulingPolicy.js';
import AvailabilityRule from '../../src/models/availabilityRule.js';
import VoiceSession from '../../src/models/voiceSession.js';
import VoiceHandoff from '../../src/voice/voiceHandoff.service.js';
import { requestStaffSchedulingReview } from '../../src/services/booking/staffSchedulingReview.service.js';
import { escalateOverdueInterventions } from '../../src/services/interventionEscalation.service.js';
import { processTwilioCallStatus } from '../../src/services/twilioCallStatus.service.js';
import AvailabilityService from '../../src/services/scheduling/availability.service.js';
import AppointmentService from '../../src/services/scheduling/appointment.service.js';
import { drainSmsProcessingQueueOnce } from '../../src/workers/smsProcessing.worker.js';
import { sendSms } from '../../src/services/twilioSmsService.js';

jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));

const base = 'http://127.0.0.1:43771';
const uiDir = path.resolve(process.env.CALLBACKIQ_FRONTEND_DIR || '../callbackiq_frontend');
let mongo, browser, server, context, page, business, owner, lead, conversation, token, foreignAlert;
const failures = [];
let sequence = 0;
const sid = () => `SM${String(++sequence).padStart(32, '0')}`;

async function api(url, { method = 'GET', data, bearer = token } = {}) {
  const response = await context.request.fetch(`${base}/api${url}`, {
    method, headers: { Authorization: `Bearer ${bearer}` }, ...(data ? { data } : {}),
  });
  return { status: response.status(), body: await response.json() };
}
async function visit(route) {
  await page.goto(`${base}${route}`);
  await page.waitForLoadState('networkidle');
  expect(new URL(page.url()).pathname).toBe(new URL(route, base).pathname);
}
async function visible(locator) { await locator.first().waitFor({ state: 'visible', timeout: 15000 }); }

beforeAll(async () => {
  if (!fs.existsSync(path.join(uiDir, 'build/index.html'))) throw new Error(`Build the frontend first: ${uiDir}`);
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Alert.init(), CallLog.init(), Message.init(), Appointment.init()]);
  owner = await User.create({ userName: 'Browser Owner', email: 'owner@example.test', password: 'unused-test-hash', businessName: 'Browser HVAC', role: 'owner', emailVerified: true, termsAccepted: true, privacyAccepted: true });
  business = await Business.create({ owner: owner._id, businessName: 'Browser HVAC', businessType: 'hvac', phone: '+14045550199', forwardingPhone: '+14045550198', timezone: 'America/New_York', isActive: true, trackingNumber: { status: 'active' }, messagingCompliance: { smsReady: true, a2pStatus: 'registered', senderAttached: true }, features: { missedCallSmsEnabled: true, aiQualificationEnabled: true, aiBookingEnabled: false } });
  await Subscription.create({ business: business._id, status: 'active', isActive: true, plan: 'pro', currentPeriodEnd: new Date(Date.now()+30*86400000) });
  token = Token.sign({ userId: String(owner._id), role: 'owner', sessionVersion: 0 });
  lead = await Lead.create({ business: business._id, customerName: 'Browser Customer', phone: '+14045550100', serviceNeeded: 'HVAC repair', urgency: 'high', address: '100 Main Street Atlanta GA 30324' });
  conversation = await Conversation.create({ business: business._id, lead: lead._id, customerPhone: lead.phone, status: 'open', aiEnabled: true });
  foreignAlert = await Alert.create({ business: new mongoose.Types.ObjectId(), type: 'human_requested', title: 'Private other business request', message: 'Must never be visible', priority: 'critical', actionRequired: true });
  sendSms.mockImplementation(async () => { const id=sid(); return { sid:id, providerMessageId:id, status:'sent', suppressed:false }; });
  const shell = express();
  shell.use((req,res,next) => req.path.startsWith('/api/') ? app(req,res,next) : next());
  shell.use(express.static(path.join(uiDir, 'build')));
  shell.get('/{*path}', (req,res) => res.sendFile(path.join(uiDir, 'build/index.html')));
  server = await new Promise((resolve,reject) => { const s=shell.listen(43771,'127.0.0.1',()=>resolve(s)); s.on('error',reject); });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Confirm the seeded owner can reach protected data before testing UI flows.
  const accessProbe = await api('/calls');
  expect(accessProbe).toMatchObject({ status: 200 });
  page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  // Retarget the built SPA's API origin to this isolated server. Responses are
  // never fabricated: every request runs through the real mounted middleware.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...route.request().headers(), authorization: `Bearer ${token}`, origin: base };
      delete headers.host; delete headers.cookie;
      const response = await context.request.fetch(`${base}${url.pathname}${url.search}`, {
        method: route.request().method(), headers,
        ...(route.request().postData() ? { data: route.request().postData() } : {}),
      });
      return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': base, 'access-control-allow-credentials': 'true' } });
    }
    if (url.origin !== base) return route.abort();
    return route.continue();
  });
}, 120000);

afterAll(async () => {
  await context?.close(); await browser?.close();
  if (server) await new Promise(resolve=>server.close(resolve));
  await mongoose.disconnect(); await mongo?.stop();
});
afterEach(async () => {
  if (page && expect.getState().currentTestName) {
    const dir=path.resolve('browser-results');fs.mkdirSync(dir,{recursive:true});
    await page.screenshot({path:path.join(dir,expect.getState().currentTestName.replace(/[^a-z0-9]+/gi,'-').slice(0,150)+'.png'),fullPage:true});
  }
  expect(failures.splice(0)).toEqual([]);
});

test('missed recovery call stays missed after completed and is visible in Call Logs', async () => {
  const call=await CallLog.create({business:business._id,lead:lead._id,conversation:conversation._id,from:lead.phone,to:business.phone,status:'missed',disposition:'missed',provider:'twilio',providerCallId:'CA'+ '1'.repeat(32),missedCallTextSent:true});
  await processTwilioCallStatus({businessId:business._id,payload:{CallSid:call.providerCallId,CallStatus:'completed',CallDuration:'15'}});
  expect((await CallLog.findById(call._id)).status).toBe('missed');
  await visit('/call-logs'); await visible(page.getByText(lead.phone,{exact:true}));
});

test.each(['My electrical panel is sparking', 'The breaker panel smells like it is burning but I see no flames', 'My child is pinned under the garage door', 'My dryer smells like burning and is smoking'])('incoming hazardous SMS creates durable critical review: %s', async hazard => {
  const messageSid=sid();
  const response=await context.request.post(`${base}/api/twilio/sms`,{form:{From:lead.phone,To:business.phone,Body:hazard,MessageSid:messageSid}});
  expect(response.status()).toBe(200);
  const alert=await Alert.findOne({business:business._id,dedupeKey:`human_handoff:${messageSid}`});
  expect(alert).toMatchObject({priority:'critical',actionRequired:true}); expect(alert.dueAt).toBeInstanceOf(Date);
  await visit('/intervention-center'); await visible(page.getByText(hazard,{exact:false}));
  await drainSmsProcessingQueueOnce();
  expect(await Alert.countDocuments({business:business._id,dedupeKey:`human_handoff:${messageSid}`})).toBe(1);
});

test('unaccepted voice handoff has a deadline and remains pending for staff', async () => {
  const session=await VoiceSession.create({business:business._id,lead:lead._id,conversation:conversation._id,providerCallSid:'CA'+'2'.repeat(32),status:'active'});
  await session.populate(['business','lead','conversation']);
  await VoiceHandoff.request({session,reason:'browser_voice_safety',priority:'critical',alertType:'safety_emergency',customerMessage:'I smell gas near the furnace'});
  const alert=await Alert.findOne({business:business._id,dedupeKey:`voice_handoff:${session._id}:browser_voice_safety`});
  expect(alert.dueAt).toBeInstanceOf(Date); expect(alert.acknowledgedAt).toBeNull();
  expect((await VoiceSession.findById(session._id)).transferredToHuman).toBe(false);
  await visit('/intervention-center'); await visible(page.getByText('I smell gas near the furnace',{exact:false}));
});

test('no-response escalation is visible and owner acknowledgment persists without booking', async () => {
  const alert=await Alert.findOne({business:business._id,actionRequired:true,acknowledgedAt:null});
  await Alert.updateOne({_id:alert._id},{$set:{dueAt:new Date(Date.now()-60000)}});
  await escalateOverdueInterventions();
  await visit(`/intervention-center?leadId=${lead._id}`);
  await visible(page.getByText('Escalated: the staff acknowledgment deadline passed.'));
  await page.getByRole('button',{name:'Accept request & take over'}).first().click();
  await visible(page.getByText('Request accepted. You own the next action and AI is paused.',{exact:false}));
  expect(await Alert.countDocuments({business:business._id,acknowledgedAt:{$ne:null}})).toBeGreaterThan(0);
  expect(await Appointment.countDocuments({business:business._id})).toBe(0);
});

test('same-day voice scheduling review appears without creating or confirming an appointment', async () => {
  const result=await requestStaffSchedulingReview({business,lead,conversation,customerMessage:'I need someone today',channel:'voice'});
  expect(result.reply).toMatch(/not a confirmed appointment/);
  await visit('/intervention-center'); await visible(page.getByText('I need someone today',{exact:false}));
  expect(await Appointment.countDocuments({business:business._id})).toBe(0);
});

test('owner can approve, reschedule and cancel a policy-checked customer hold through the UI', async () => {
  const service=await ServiceOffering.create({business:business._id,name:'HVAC repair',category:'hvac',active:true,aiCanDiscuss:true,aiCanBook:true,durationMinutes:60,keywords:['HVAC repair']});
  await ServiceArea.create({business:business._id,zipCodes:['30324']});
  await SchedulingPolicy.create({business:business._id,minimumNoticeMinutes:60,allowSameDayBooking:true});
  await AvailabilityRule.insertMany(Array.from({length:7},(_,dayOfWeek)=>({business:business._id,dayOfWeek,enabled:true,capacity:1,windows:[{startTime:'08:00',endTime:'18:00'}]})));
  const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const available=await AvailabilityService.getAvailability({business,serviceOfferingId:service._id,startDate:day,endDate:day,postalCode:'30324'});
  expect(available.slots.length).toBeGreaterThan(0);
  const hold=await AppointmentService.create({business,confirm:false,input:{serviceOfferingId:service._id,customerName:lead.customerName,customerPhone:lead.phone,lead:lead._id,conversation:conversation._id,address:{street:'100 Main Street',city:'Atlanta',state:'GA',postalCode:'30324'},startAt:available.slots[0].startAt,endAt:available.slots[0].endAt,bookedBy:'ai',source:'sms',requiresBusinessApproval:true,holdMinutes:30}});
  await visit(`/appointments?appointmentId=${hold._id}`);
  await page.getByRole('button',{name:'Accept & notify customer'}).click();
  await visible(page.getByRole('button',{name:'Mark completed'}));
  expect((await Appointment.findById(hold._id)).status).toBe('confirmed');
  expect(await AppointmentNotificationJob.countDocuments({appointment:hold._id})).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Reschedule',exact:true}).click();
  const nextDay=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
  const reschedulePanel = page.locator('.owner-appointment-action-panel').filter({ has: page.getByText('Choose an open replacement time', { exact: true }) });
  await reschedulePanel.getByLabel('Search from').fill(nextDay);
  await reschedulePanel.getByLabel('Search through').fill(nextDay);
  await reschedulePanel.getByRole('button',{name:'Check availability',exact:true}).click();
  const replacement=reschedulePanel.getByLabel('Open replacement time');
  await replacement.locator('option').nth(1).waitFor({state:'attached'});
  await replacement.selectOption({index:1});
  await reschedulePanel.getByRole('button',{name:'Reschedule to selected time'}).click();
  await visible(page.getByText('Appointment rescheduled and confirmed.'));
  const original=await Appointment.findById(hold._id);
  expect(original.status).toBe('rescheduled');
  expect(original.rescheduledTo).toBeTruthy();
  await visit(`/appointments?appointmentId=${original.rescheduledTo}`);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByLabel('Cancellation reason').fill('Customer requested cancellation');
  const cancellationResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/appointments/${original.rescheduledTo}/cancel` && response.request().method() === 'POST');
  await page.getByRole('button',{name:'Confirm cancellation'}).click();
  const canceled = await cancellationResponse;
  expect(canceled.status()).toBe(200);
  expect(await canceled.json()).toMatchObject({ success: true, data: { status: 'canceled' } });
  await visible(page.getByText('Appointment canceled.', { exact: true }));
  expect((await Appointment.findById(original.rescheduledTo)).status).toBe('canceled');
});

test('setup persists a newly supported trade and shows clear trial wording', async () => {
  await visit('/setup');
  await page.locator('select[name="businessType"]').selectOption('appliance_repair');
  expect(await page.locator('select[name="businessType"]').inputValue()).toBe('appliance_repair');
  const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/businesses/mine' && response.request().method() === 'PATCH');
  await page.getByRole('button',{name:/continue|next/i}).click();
  const saved = await savedResponse;
  expect(saved.request().postDataJSON()).toMatchObject({ businessType: 'appliance_repair' });
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ data: { businessType: 'appliance_repair' } });
  expect((await Business.findById(business._id)).businessType).toBe('appliance_repair');
  await visit('/setup?step=activate');
  await visible(page.getByText('Pro features, free for 14 days'));
  expect(await page.getByText('Pro · $99/month paid plan').count()).toBe(0);
});

test('mobile navigation works across both layout entry points', async () => {
  await page.setViewportSize({width:390,height:844});
  for(const route of ['/dashboard','/call-logs','/billing']) {
    await visit(route); await page.getByRole('button',{name:'Menu',exact:true}).click();
    await visible(page.getByRole('link',{name:'Needs Attention'}));
    await page.keyboard.press('Escape');
    expect(await page.getByRole('button',{name:'Menu',exact:true}).getAttribute('aria-expanded')).toBe('false');
    const overflow = await page.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth, scrollX: window.scrollX,
      elements: Array.from(document.querySelectorAll('body *')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 10).map(node => ({tag: node.tagName, className: node.className})),
    }));
    if (overflow.width > overflow.viewport + 1) throw new Error(`Mobile overflow: ${JSON.stringify({ route, ...overflow })}`);
  }
  await page.setViewportSize({width:1280,height:900});
});

test('owner cannot read or acknowledge another business intervention', async () => {
  const denied=await api(`/interventions/${foreignAlert._id}/acknowledge`,{method:'POST',data:{}});
  expect(denied.status).toBe(404);
  expect((await Alert.findById(foreignAlert._id)).acknowledgedAt).toBeNull();
  await visit('/intervention-center'); expect(await page.getByText('Private other business request').count()).toBe(0);
});
