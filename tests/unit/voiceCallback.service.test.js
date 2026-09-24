import Alert from "../../src/models/alert.js";
import Message from "../../src/models/message.js";
import SocketService from "../../src/services/socket.service.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import VoiceCallbackService from "../../src/voice/voiceCallback.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));
jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitLeadUpdated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitMessageCreated: jest.fn(),
    emitAlertCreated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
  logOperationalWarning: jest.fn(),
}));

const makeSession = () => {
  const lead = {
    _id: "lead-1",
    customerName: "Voice Caller",
    phone: "+14045550111",
    serviceNeeded: "Unknown",
    urgency: "medium",
    address: "",
    preferredAppointmentTime: "",
    status: "new",
    notes: "",
    save: jest.fn().mockResolvedValue(undefined),
  };
  const conversation = {
    _id: "conversation-1",
    customerName: "Voice Caller",
    bookingState: { status: "not_started" },
    humanTakeover: false,
    aiEnabled: true,
    lastMessage: "",
    save: jest.fn().mockResolvedValue(undefined),
  };
  return {
    _id: "session-1",
    providerCallSid: "CA123",
    from: "+14045550111",
    to: "+14045550122",
    status: "active",
    confirmationSmsStatus: "pending",
    confirmationSmsProviderMessageId: "",
    metadata: {},
    transcript: [{ role: "customer", text: "I need drain cleaning" }],
    business: {
      _id: "business-1",
      businessName: "Atlanta Pro Plumbing",
      phone: "+14045550122",
      features: { missedCallSmsEnabled: true },
    },
    lead,
    conversation,
    save: jest.fn().mockResolvedValue(undefined),
  };
};

describe("VoiceCallbackService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Alert.findOneAndUpdate.mockResolvedValue({ _id: "alert-1" });
    Message.create.mockResolvedValue({ _id: "message-1" });
    sendSms.mockResolvedValue({ sid: "SM123", status: "sent" });
  });

  test("collects details, creates an intervention alert, and sends confirmation", async () => {
    const session = makeSession();

    let result = await VoiceCallbackService.handle({
      session,
      customerMessage: "I need drain cleaning",
      reason: "voice_booking_not_enabled",
      seedServiceFromMessage: true,
    });
    expect(result.reply).toMatch(/what name/i);
    expect(session.metadata.callbackCapture.status).toBe("collecting_name");

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "DeMeco Bell",
    });
    expect(result.reply).toMatch(/address|zip/i);

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "30303",
    });
    expect(result.reply).toMatch(
      /day or time|prefer.*(?:contact|schedule)|when.*(?:contact|schedule)/i,
    );


    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "Tomorrow afternoon",
    });

        expect(result.reply).toMatch(/is that correct/i);
    expect(result.callbackCaptured).toBe(false);

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "yes",
    });
expect(result.callbackCaptured).toBe(true);
    expect(JSON.parse(result.handoff.handoffData)).toMatchObject({
      reasonCode: "callback-captured",
      callbackCaptured: true,
    });
    expect(session.lead).toMatchObject({
      customerName: "DeMeco Bell",
      serviceNeeded: "I need drain cleaning",
      address: "30303",
      urgency: "medium",
      preferredAppointmentTime: "Tomorrow afternoon",
      status: "new",
    });
    expect(session.conversation).toMatchObject({
      humanTakeover: false,
      aiEnabled: true,
    });
    expect(session.conversation.bookingState.status).toBe("not_started");
    expect(session.conversation.orchestration.phase).toBe("handoff_pending");
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          actionRequired: true,
          title: "Customer callback requested",
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "voice_callback_capture",
        usageCategory: "voice_callback_confirmation",
      }),
    );
    expect(Message.create).toHaveBeenCalled();

    const outboundBody = sendSms.mock.calls.at(-1)?.[0]?.body || "";
    expect(outboundBody).toMatch(/callback time is not guaranteed/i);
    expect(outboundBody).not.toMatch(/team will follow up/i);
    expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
      "business-1",
      "voice_callback_captured",
    );
  });

  test("creates a critical safety alert without promising or texting a callback", async () => {
    const session = makeSession();

    const result = await VoiceCallbackService.handle({
      session,
      customerMessage: "I smell gas",
      reason: "safety_emergency:gas",
      alertType: "safety_emergency",
      priority: "critical",
      seed: {
        serviceNeeded: "Potential gas emergency",
        urgency: "emergency",
      },
      immediate: true,
      sendConfirmationSms: false,
      completionReply: "Call 911 now and do not wait for a callback.",
    });

    expect(result.reply).toMatch(/call 911/i);
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          type: "safety_emergency",
          priority: "critical",
        }),
      }),
      expect.any(Object),
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  test("does not resend a provider-accepted SMS when local message logging fails", async () => {
    const session = makeSession();
    Message.create.mockRejectedValueOnce(new Error("database unavailable"));

    await VoiceCallbackService.handle({
      session,
      customerMessage: "",
      reason: "callback_requested",
      requiredFields: [],
      seed: {
        serviceNeeded: "Drain cleaning",
        customerName: "DeMeco Bell",
        location: "30303",
        urgency: "high",
        preferredTime: "Tomorrow afternoon",
      },
      immediate: true,
    });

    expect(session.confirmationSmsStatus).toBe("sent");
    expect(sendSms).toHaveBeenCalledTimes(1);

    await VoiceCallbackService.handle({
      session,
      customerMessage: "",
      reason: "callback_requested",
      requiredFields: [],
      seed: {
        serviceNeeded: "Drain cleaning",
        customerName: "DeMeco Bell",
        location: "30303",
        urgency: "high",
        preferredTime: "Tomorrow afternoon",
      },
      immediate: true,
    });

    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  test("suppresses confirmation when the business disabled missed-call SMS", async () => {
    const session = makeSession();
    session.business.features.missedCallSmsEnabled = false;
    session.lead.customerName = "DeMeco Bell";
    session.lead.serviceNeeded = "Drain cleaning";
    session.lead.address = "30303";
    session.lead.preferredAppointmentTime = "Tomorrow";

    const result = await VoiceCallbackService.handle({
      session,
      customerMessage: "Today",
      reason: "callback_requested",
      seed: {
        urgency: "high",
        urgencyDetail: "Today",
      },
      requiredFields: [],
      immediate: true,
    });

    expect(result.callbackCaptured).toBe(true);
    expect(session.confirmationSmsStatus).toBe("suppressed");
    expect(sendSms).not.toHaveBeenCalled();
  });
});

test('failed callback alert does not persist completed callback state', async () => {
 const session=makeSession();
 Alert.findOneAndUpdate.mockRejectedValueOnce(new Error('alert write failed'));
 await expect(VoiceCallbackService.handle({session,customerMessage:'unclear',reason:'unrecognized_voice_turn',immediate:true,sendConfirmationSms:false})).rejects.toThrow('alert write failed');
 expect(session.metadata.callbackCapture?.completedAt).toBeFalsy();
 expect(session.conversation.orchestration?.handoffStatus).not.toBe('acknowledged');
});

describe('callback truthfulness under dependency failures',()=>{
 beforeEach(()=>{jest.clearAllMocks();Alert.findOneAndUpdate.mockResolvedValue({_id:'alert-1'});sendSms.mockResolvedValue({sid:'SM123',status:'sent'});Message.create.mockResolvedValue({_id:'message-1'});});
 const submit=session=>VoiceCallbackService.handle({session,customerMessage:'Please call me',reason:'customer_requested_human',immediate:true,requiredFields:[],sendConfirmationSms:true,seed:{serviceNeeded:'Drain cleaning',customerName:'Customer',location:'123 Main St Atlanta GA 30324',preferredTime:'Friday 10 AM'}});
 test('missing alert result cannot report a saved request',async()=>{
  const session=makeSession();Alert.findOneAndUpdate.mockResolvedValueOnce(null);
  await expect(submit(session)).rejects.toMatchObject({code:'STAFF_ACTION_NOT_SAVED'});
  expect(session.metadata.callbackCapture?.completedAt).toBeFalsy();expect(sendSms).not.toHaveBeenCalled();
 });
 test('lead write failure stops alert and confirmation',async()=>{
  const session=makeSession();session.lead.save.mockRejectedValueOnce(new Error('lead write failed'));
  await expect(submit(session)).rejects.toThrow('lead write failed');expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();expect(sendSms).not.toHaveBeenCalled();
 });
 test('conversation write failure cannot emit a successful confirmation',async()=>{
  const session=makeSession();session.conversation.save.mockRejectedValueOnce(new Error('conversation write failed'));
  await expect(submit(session)).rejects.toThrow('conversation write failed');expect(session.metadata.callbackCapture?.completedAt).toBeFalsy();expect(sendSms).not.toHaveBeenCalled();
 });
 test('SMS delivery failure preserves saved request and discloses failed text',async()=>{
  const session=makeSession();sendSms.mockRejectedValueOnce(new Error('provider unavailable'));
  const result=await submit(session);expect(result.callbackCaptured).toBe(true);expect(session.confirmationSmsStatus).toBe('failed');expect(result.reply).toMatch(/confirmation text could not be sent/i);expect(Alert.findOneAndUpdate).toHaveBeenCalledTimes(1);
 });
});


test('callback acknowledgment does not imply staff acceptance',async()=>{
 jest.clearAllMocks();
 Alert.findOneAndUpdate.mockResolvedValue({_id:'alert-1'});
 const session=makeSession();
 const result=await VoiceCallbackService.handle({session,customerMessage:'Please call me',reason:'customer_requested_human',requiredFields:[],immediate:true,sendConfirmationSms:false});
 expect(result.callbackCaptured).toBe(true);
 expect(session.conversation.orchestration).toMatchObject({phase:'handoff_pending',handoffStatus:'acknowledged'});
 expect(session.conversation.humanTakeover).toBe(false);
 expect(session.conversation.aiEnabled).toBe(true);
 const payload=Alert.findOneAndUpdate.mock.calls[0][1].$setOnInsert;
 expect(payload).toMatchObject({status:'pending',actionRequired:true});
 expect(payload.acknowledgedAt).toBeUndefined();
 expect(payload.acknowledgedBy).toBeUndefined();
 expect(payload.assignedTo).toBeUndefined();
});

describe('callback fact ownership and recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks(); Alert.findOneAndUpdate.mockResolvedValue({ _id: 'alert-1' });
  });
  const turn = (session, customerMessage, extra = {}) => VoiceCallbackService.handle({ session, customerMessage, sendConfirmationSms: false, ...extra });
  const fresh = () => { const session = makeSession(); session.business.features.missedCallSmsEnabled = false; return session; };
  test('out-of-order details never become the requested name and survive readback and confirmation', async () => {
    const s = fresh();
    await turn(s, 'I need drain cleaning');
    await turn(s, 'Actually I need my kitchen faucet replaced');
    expect(s.metadata.callbackCapture.customerName).toBe('');
    await turn(s, '970 Sidney Marcus Atlanta GA 30324');
    await turn(s, 'Friday at 10 am');
    expect(s.metadata.callbackCapture.currentField).toBe('name');
    const readback = await turn(s, 'DeMeco Bell');
    expect(readback.reply).toMatch(/kitchen faucet replaced/);
    expect(readback.reply).toContain('970 Sidney Marcus Atlanta GA 3 0 3 2 4');
    expect(readback.reply).toContain('Friday at 10 am');
    expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
    const result = await turn(s, 'Yes');
    expect(result.callbackCaptured).toBe(true);
    expect(s.lead).toMatchObject({ serviceNeeded: 'my kitchen faucet replaced', customerName: 'DeMeco Bell', address: '970 Sidney Marcus Atlanta GA 30324', preferredAppointmentTime: 'Friday at 10 am' });
    expect(Alert.findOneAndUpdate.mock.calls[0][1].$setOnInsert.aiSummary).toContain('Friday at 10 am');
  });
  test('a newer durable edit requires a fresh readback before confirmation after reload', async () => {
    const s = fresh(); Object.assign(s.lead, { customerName: 'Pat Smith', serviceNeeded: 'Sink replacement', address: '123 Main St Atlanta GA 30324', preferredAppointmentTime: 'Friday at 10 am' });
    await turn(s, 'Please call me');
    s.metadata = JSON.parse(JSON.stringify(s.metadata));
    s.lead.address = '456 Oak St Atlanta GA 30326';
    s.lead.serviceNeeded = 'Furnace repair';
    const changed = await turn(s, 'Yes');
    expect(changed.callbackCaptured).toBe(false);
    expect(changed.reply).toContain('456 Oak St Atlanta GA 3 0 3 2 6');
    expect(changed.reply).toContain('Furnace repair');
    expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
    expect((await turn(s, 'Yes')).callbackCaptured).toBe(true);
    expect(s.lead.address).toBe('456 Oak St Atlanta GA 30326');
  });
  test('a cleared durable field is collected again instead of resurrecting the old value', async () => {
    const s = fresh(); Object.assign(s.lead, { customerName:'Pat Smith', serviceNeeded:'Sink replacement', address:'123 Main St Atlanta GA 30324', preferredAppointmentTime:'Friday at 10 am' });
    await turn(s,'Please call me'); s.lead.address='';
    const result=await turn(s,'Yes');
    expect(result.callbackCaptured).toBe(false);
    expect(s.lead.address).toBe('');
    expect(s.metadata.callbackCapture.currentField).toBe('location');
    expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
  });
  test('ZIP and time corrections retain street and day and trigger another readback', async () => {
    const s = fresh(); Object.assign(s.lead, { customerName: 'Pat Smith', serviceNeeded: 'Sink replacement', address: '123 Main St Atlanta GA 30324', preferredAppointmentTime: 'Friday at 10 am' });
    await turn(s, 'Please call me');
    await turn(s, 'Actually my ZIP is 30326');
    const result = await turn(s, 'Actually my time is 2 pm');
    expect(result.callbackCaptured).toBe(false);
    expect(result.reply).toContain('123 Main St Atlanta GA 3 0 3 2 6');
    expect(result.reply).toContain('Friday at 2 pm');
    await turn(s, 'yes');
    expect(s.lead.preferredAppointmentTime).toBe('Friday at 2 pm');
  });
  test.each(['Actually I need a furnace repaired', 'Friday at 10 am', 'Maybe later', 'What are your hours?'])('unrelated name answer is not accepted: %s', async text => {
    const s = fresh(); await turn(s, 'I need drain cleaning'); await turn(s, text);
    expect(s.lead.customerName).toBe('Voice Caller');
    expect(s.metadata.callbackCapture.customerName).toBe('');
  });
  test('emergency interrupts active callback with critical priority and current evidence', async () => {
    const s = fresh(); await turn(s, 'I need drain cleaning');
    const result = await turn(s, 'I smell gas and feel dizzy', { immediate: true, reason: 'safety_emergency:gas', alertType: 'safety_emergency', seed: { urgencyDetail: 'I smell gas and feel dizzy' }, completionReply: 'Call 911. Do not wait for a callback.' });
    expect(result.callbackCaptured).toBe(true);
    expect(Alert.findOneAndUpdate.mock.calls[0][1].$setOnInsert).toMatchObject({ type: 'safety_emergency', priority: 'critical' });
    expect(s.lead.urgency).toBe('emergency');
  });
});

describe('same-call address recovery', () => {
 test('callback entry reuses an earlier ASR address instead of asking again', async () => {
  const session = makeSession();
  session.lead.serviceNeeded = 'Faucet replacement';
  session.lead.customerName = 'Test Caller';
  session.transcript.push({role:'customer', isFinal:true, text:'9 70 Roswell Road, Atlanta, Georgia 3 0 3 2 4.'});
  const result = await VoiceCallbackService.handle({session, customerMessage:'Scheduling.', requiredFields:['service','name','location','preference']});
  expect(session.lead.address).toBe('970 Roswell Road, Atlanta, Georgia 30324');
  expect(session.metadata.callbackCapture.currentField).toBe('preference');
  expect(result.reply).not.toMatch(/what is the service address/i);
 });
 test('already-provided response repairs an active empty callback location', async () => {
  const session = makeSession();
  session.lead.serviceNeeded = 'Faucet replacement';
  session.lead.customerName = 'Test Caller';
  await VoiceCallbackService.handle({session, customerMessage:'Please call me', requiredFields:['service','name','location','preference']});
  expect(session.metadata.callbackCapture.currentField).toBe('location');
  session.transcript.push({role:'customer', text:'9 70 Roswell Road, Atlanta, Georgia 3 0 3 2 4.'});
  await VoiceCallbackService.handle({session, customerMessage:'I already gave you that information.'});
  expect(session.metadata.callbackCapture.currentField).toBe('preference');
  expect(session.metadata.callbackCapture.retryCounts.location || 0).toBe(0);
 });
 test('assistant and unfinished transcript text are not customer location evidence', async () => {
  const session = makeSession();
  session.lead.serviceNeeded = 'Faucet replacement';
  session.lead.customerName = 'Test Caller';
  session.transcript.push({role:'assistant', text:'125 Main Street 30324'}, {role:'customer', isFinal:false, text:'87 Oak Lane 30060'});
  await VoiceCallbackService.handle({session, customerMessage:'Please call me', requiredFields:['service','name','location']});
  expect(session.metadata.callbackCapture.currentField).toBe('location');
 });
});
