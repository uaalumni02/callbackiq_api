import request from "supertest";
import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import User from "../../src/models/user.js";
import { signedTwilioPost } from "../helpers/signTwilioRequest.js";
import { getTwilioClient } from "../../src/services/twilioSmsService.js";
import { drainWebhookWorkOnce } from "../../src/workers/webhookWork.worker.js";
import Token from "../../src/helpers/jwt/token.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
async function fixture(status = "past_due", extra = {}) {
  const owner = await User.create({
    userName: "pilot-owner",
    email: "pilot@example.test",
    password: "inert-hash",
    businessName: "Pilot fixture",
    role: "owner",
    emailVerifiedAt: new Date(),
  });
  const business = await Business.create({
    owner: owner._id,
    businessName: "Pilot fixture",
    forwardingPhone: "+14045550101",
    phone: "+14045550102",
    trackingNumber: { status: "active", providerSid: "PN_PILOT" },
    features: { voiceAiEnabled: true },
    voiceSettings: { answerMode: "always" },
    messagingCompliance: {
      smsReady: true,
      senderAttached: true,
      a2pStatus: "registered",
    },
  });
  const subscription = await Subscription.create({
    business: business._id,
    status,
    isActive: ["active", "trialing"].includes(status),
    trialEndsAt: new Date(Date.now() + 86400000),
    ...extra,
  });
  return {
    owner,
    business,
    subscription,
    token: Token.sign({ userId: owner._id, role: "owner", sessionVersion: 0 }),
  };
}
test.each([
  "past_due",
  "none",
  "incomplete",
  "expired",
  "unpaid",
  "paused",
  "canceled",
  "incomplete_expired",
])("B04 %s callers get no AI and no recovery SMS", async (status) => {
  const { business } = await fixture(status);
  const send = jest
    .spyOn(getTwilioClient().messages, "create")
    .mockResolvedValue({ sid: "SM_PILOT" });
  const r = await signedTwilioPost(app, "/api/twilio/voice", {
    CallSid: "CA_PILOT",
    From: "+14045550103",
    To: business.phone,
  });
  expect(r.status).toBe(200);
  expect(r.text).not.toContain("ConversationRelay");
  expect(r.text).toMatch(/not available|unavailable|inactive/i);
  expect(send).not.toHaveBeenCalled();
});
test("B04 queued recovery is canceled when entitlement changes before dispatch", async () => {
  const { business, subscription } = await fixture("active");
  await Business.updateOne(
    { _id: business._id },
    {
      $set: {
        "features.voiceAiEnabled": false,
        "voiceSettings.answerMode": "disabled",
      },
    },
  );
  process.env.RECOVERY_SMS_ASYNC_ENABLED = "true";
  const send = jest
    .spyOn(getTwilioClient().messages, "create")
    .mockResolvedValue({ sid: "SM_PILOT" });
  await signedTwilioPost(app, "/api/twilio/voice", {
    CallSid: "CA_PILOT",
    From: "+14045550103",
    To: business.phone,
  });
  await Subscription.updateOne(
    { _id: subscription._id },
    { $set: { status: "past_due", isActive: false } },
  );
  await drainWebhookWorkOnce();
  expect(send).not.toHaveBeenCalled();
});
test("H09 past_due can read saved lead and conversation lists but cannot mutate", async () => {
  const { token } = await fixture();
  for (const path of ["/api/leads", "/api/conversations"]) {
    const r = await request(app)
      .get(path)
      .set("Authorization", "Bearer " + token);
    expect(r.status).toBe(200);
  }
  const r = await request(app)
    .post("/api/leads")
    .set("Authorization", "Bearer " + token)
    .send({ customerName: "Example" });
  expect(r.status).toBe(403);
});
test("B04 activation and a new turn are denied after subscription revocation", async () => {
  const { business } = await fixture();
  const { default: Sessions } =
    await import("../../src/voice/voiceSession.service.js");
  const { default: Session } = await import("../../src/models/voiceSession.js");
  const session = await Session.create({
    business: business._id,
    providerCallSid: "CA_PILOT",
    status: "routing",
  });
  await expect(
    Sessions.activateFromSetup({
      voiceSessionId: session._id,
      setup: {
        callSid: "CA_PILOT",
        sessionId: "VX_PILOT",
        customParameters: { businessId: String(business._id) },
      },
    }),
  ).rejects.toMatchObject({ code: "PROVIDER_ENTITLEMENT_REQUIRED" });
  const { runVoiceConversationTurn } =
    await import("../../src/services/voiceConversationTurn.service.js");
  const operation = jest.fn();
  await expect(
    runVoiceConversationTurn({
      session: { business },
      customerMessage: "Hello",
      operation,
    }),
  ).rejects.toMatchObject({ code: "PROVIDER_ENTITLEMENT_REQUIRED" });
  expect(operation).not.toHaveBeenCalled();
});
test("B04 OpenAI wrapper has no permissive missing-context or inactive-account path", async () => {
  const { business } = await fixture();
  const { createOpenAIClient } =
    await import("../../src/integrations/providerClients.js");
  const { withProviderBusiness } =
    await import("../../src/services/providerEntitlement.service.js");
  const ai = createOpenAIClient("pilotEntitlement", {
    apiKey: "inert-fixture",
  });
  await expect(ai.responses.create({ model: "offline" })).rejects.toMatchObject(
    { code: "PROVIDER_ENTITLEMENT_REQUIRED" },
  );
  await expect(
    withProviderBusiness(business._id, () =>
      ai.responses.create({ model: "offline" }),
    ),
  ).rejects.toMatchObject({ code: "PROVIDER_ENTITLEMENT_REQUIRED" });
});

test('H09 past-due owners can read saved settings while writes remain blocked',async()=>{
 const {token}=await fixture('past_due');const result=await request(app).get('/api/business-configuration/owner-settings').set('Authorization',`Bearer ${token}`);expect(result.status).toBe(200);
 const write=await request(app).put('/api/business-configuration/owner-settings/team').set('Authorization',`Bearer ${token}`).send({revision:result.body.data.revision,values:result.body.data.sections.team});expect(write.status).toBe(403);
});
test.each(['past_due','unpaid','paused','canceled','expired'])('B04 %s cannot send or approve chargeable phone verification',async status=>{
 const {owner}=await fixture(status);process.env.TWILIO_VERIFY_SERVICE_SID='VE_SYNTHETIC';
 const clients=await import('../../src/integrations/providerClients.js');
 const create=jest.fn().mockResolvedValue({status:'approved'});
 const sdk=jest.spyOn(clients,'createTwilioClient').mockReturnValue({verify:{v2:{services:()=>({verifications:{create},verificationChecks:{create}})}}});
 const service=await import('../../src/services/trialIdentityVerification.service.js');
 try {
  await expect(service.startForwardingPhoneVerification({ownerId:owner._id})).rejects.toMatchObject({code:'PROVIDER_ENTITLEMENT_REQUIRED'});
  await expect(service.checkForwardingPhoneVerification({ownerId:owner._id,code:'123456'})).rejects.toMatchObject({code:'PROVIDER_ENTITLEMENT_REQUIRED'});
  expect(create).not.toHaveBeenCalled();
 }finally{sdk.mockRestore();}
});
test('B04 unused trial preparation can verify its forwarding phone without activating paid services',async()=>{
 const {owner,business}=await fixture('none',{lastPaymentStatus:'trial_preparing',trialCount:0});
 process.env.TWILIO_VERIFY_SERVICE_SID='VE_SYNTHETIC';
 const clients=await import('../../src/integrations/providerClients.js');const create=jest.fn().mockResolvedValue({status:'pending'});
 const sdk=jest.spyOn(clients,'createTwilioClient').mockReturnValue({verify:{v2:{services:()=>({verifications:{create}})}}});
 try {
  const service=await import('../../src/services/trialIdentityVerification.service.js');
  await expect(service.startForwardingPhoneVerification({ownerId:owner._id})).resolves.toMatchObject({status:'pending'});
  expect(create).toHaveBeenCalledTimes(1);
  const {readProviderEntitlement}=await import('../../src/services/providerEntitlement.service.js');
  expect((await readProviderEntitlement(business._id)).allowed).toBe(false);
 }finally{sdk.mockRestore();}
});
test('B04 persisted inbound SMS work is suppressed after payment changes while it waits in the queue',async()=>{
 const {stabilizationFixture}=await import('../setup/stabilizationFixture.js');
 const {default:Message}=await import('../../src/models/message.js');
 const {processInboundSmsJob}=await import('../../src/services/messaging/inboundSmsJobProcessor.service.js');
 const {business,lead,conversation}=await stabilizationFixture();
 const inbound=await Message.create({business:business._id,conversation:conversation._id,lead:lead._id,direction:'inbound',from:'+14045550100',to:'+14045550101',body:'tomorrow morning'});
 await Subscription.updateOne({business:business._id},{$set:{status:'past_due',isActive:false}});
 await expect(processInboundSmsJob({business:business._id,lead:lead._id,conversation:conversation._id,inboundMessage:inbound._id})).resolves.toEqual({decision:'skipped',reason:'subscription_inactive',sent:false});
 expect(await Message.countDocuments({business:business._id,direction:'outbound'})).toBe(0);
 expect(await Message.countDocuments({business:business._id,direction:'inbound'})).toBe(1);
});
