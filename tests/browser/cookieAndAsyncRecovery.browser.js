// Cookie-authenticated SPA and durable recovery queue. Local HTTP cookie flags
// differ from deployed HTTPS flags; production Secure/SameSite remains staging.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chromium } from 'playwright';
import app from '../../src/app.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import CallLog from '../../src/models/callLog.js';
import Work from '../../src/models/webhookWork.js';
import { claimWebhookWork, enqueueWebhookWork } from '../../src/services/webhooks/webhookWork.service.js';
import { drainWebhookWorkOnce } from '../../src/workers/webhookWork.worker.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
const base = 'http://127.0.0.1:43771', password = 'BrowserTest123!';
let mongo, browser, server, context, page, business, owner;
beforeAll(async () => {
 process.env.RECOVERY_SMS_ASYNC_ENABLED = 'true';
 const uiDir = path.resolve(process.env.CALLBACKIQ_FRONTEND_DIR || '../callbackiq_frontend');
 if (!fs.existsSync(path.join(uiDir, 'build/index.html'))) throw new Error('Build the frontend first.');
 mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
 await Promise.all([Work.init(), CallLog.init(), Lead.init()]);
 owner = await User.create({ userName: 'CookieOwner', email: 'cookie-owner@example.test', password: await bcrypt.hash(password, 10),
   businessName: 'Cookie Test Shop', role: 'owner', emailVerified: true, termsAccepted: true, privacyAccepted: true });
 business = await Business.create({ owner: owner._id, businessName: 'Cookie Test Shop', businessType: 'plumbing',
   phone: '+14045550199', forwardingPhone: '+14045550198', timezone: 'America/New_York', isActive: true,
   trackingNumber: { status: 'active' }, messagingCompliance: { smsReady: true, a2pStatus: 'registered', senderAttached: true },
   features: { missedCallSmsEnabled: true, aiQualificationEnabled: true } });
 await Subscription.create({ business: business._id, status: 'active', isActive: true, plan: 'pro', currentPeriodEnd: new Date(Date.now()+30*86400000) });
 const shell = express();
 shell.use((req, res, next) => req.path.startsWith('/api/') ? app(req, res, next) : next());
 shell.use(express.static(path.join(uiDir, 'build')));
 shell.get('/{*path}', (req, res) => res.sendFile(path.join(uiDir, 'build/index.html')));
 server = await new Promise((resolve, reject) => { const s = shell.listen(43771, '127.0.0.1', () => resolve(s)); s.on('error', reject); });
 browser = await chromium.launch({ headless: true });
}, 120000);
beforeEach(async () => {
 context = await browser.newContext(); page = await context.newPage();
 await page.route('**/*', async route => {
   const request = route.request(), url = new URL(request.url());
   if (url.origin !== base) return route.abort();
   const headers = { ...request.headers() }; delete headers.authorization;
   return route.continue({ headers });
 });
 sendSms.mockReset().mockResolvedValue({ sid: 'SM'+'9'.repeat(32), status: 'sent', suppressed: false });
});
afterEach(async () => {
 if (page) {
   fs.mkdirSync('browser-results', { recursive: true });
   await page.screenshot({ path: path.join('browser-results', expect.getState().currentTestName.replace(/[^a-z0-9]/gi, '-').slice(0, 140)+'.png'), fullPage: true });
 }
 await context?.close();
});
afterAll(async () => {
 process.env.RECOVERY_SMS_ASYNC_ENABLED = 'false';
 await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
 await mongoose.disconnect(); await mongo?.stop();
});
const login = () => context.request.post(`${base}/api/auth/login`, { data: { login: owner.email, password } });
test('owner signs in through the SPA with HttpOnly cookie, then logout clears cookie access', async () => {
 await page.goto(`${base}/login`);
 await page.getByLabel('Username or Business Email').fill(owner.email);
 await page.getByLabel('Password', { exact: true }).fill(password);
 const result = page.waitForResponse(response => response.url().endsWith('/api/auth/login'));
 await page.getByRole('button', { name: /sign in/i }).click();
 expect((await result).status()).toBe(200);
 expect((await context.cookies()).find(cookie => cookie.name === 'token')?.httpOnly).toBe(true);
 expect((await context.request.get(`${base}/api/calls`)).status()).toBe(200);
 expect((await context.request.post(`${base}/api/auth/logout`)).status()).toBe(200);
 expect((await context.cookies()).some(cookie => cookie.name === 'token')).toBe(false);
 expect((await context.request.get(`${base}/api/calls`)).status()).toBe(401);
});
test('revoked real cookie session loses protected API access', async () => {
 expect((await login()).status()).toBe(200);
 expect((await context.request.get(`${base}/api/calls`)).status()).toBe(200);
 await User.updateOne({ _id: owner._id }, { $inc: { sessionVersion: 1 } });
 expect((await context.request.get(`${base}/api/calls`)).status()).toBe(401);
});
test('async recovery survives an abandoned worker lease, sends once, and appears in owner Call Logs', async () => {
 expect((await login()).status()).toBe(200);
 const lead = await Lead.create({ business: business._id, phone: '+14045550100', customerName: 'Async Customer', serviceNeeded: 'Inspection', source: 'missed_call' });
 const conversation = await Conversation.create({ business: business._id, lead: lead._id, customerPhone: lead.phone, status: 'open', aiEnabled: true });
 const callSid = 'CA'+'8'.repeat(32);
 const call = await CallLog.create({ business: business._id, lead: lead._id, conversation: conversation._id, from: lead.phone,
   to: business.phone, status: 'missed', provider: 'twilio', providerCallId: callSid });
 const request = { kind: 'recovery_sms', businessId: business._id, eventId: callSid, payload: {
   businessId: String(business._id), leadId: String(lead._id), conversationId: String(conversation._id),
   callLogId: String(call._id), callSid, from: business.phone,
 } };
 await enqueueWebhookWork(request);
 const abandoned = await claimWebhookWork(); expect(abandoned.status).toBe('processing');
 await Work.updateOne({ _id: abandoned._id }, { $set: { leaseUntil: new Date(0) } });
 await drainWebhookWorkOnce();
 expect((await Work.findById(abandoned._id)).status).toBe('completed');
 await enqueueWebhookWork(request); await drainWebhookWorkOnce();
 expect(sendSms).toHaveBeenCalledTimes(1);
 expect((await CallLog.findById(call._id)).missedCallTextSent).toBe(true);
 await page.goto(`${base}/call-logs`);
 await page.getByText(lead.phone, { exact: true }).first().waitFor({ state: 'visible' });
});
