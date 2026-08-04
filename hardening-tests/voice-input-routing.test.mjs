import test from "node:test";
import assert from "node:assert/strict";

import {
  isUsableCallerId,
  normalizePhoneToE164,
  phoneLookupVariants,
  phoneNumbersEqual,
} from "../src/voice/voicePhone.service.js";
import {
  extractPhoneNumber,
  extractPostalCode,
  isHumanRequest,
  toSpokenReply,
} from "../src/voice/voiceInput.service.js";
import {
  conversationRelayTwiml,
  dialTwiml,
  normalizeVoiceSettings,
  staffScreenPromptTwiml,
} from "../src/voice/voiceRouting.service.js";

const business = (voiceSettings = {}) => ({
  businessName: "Atlanta Pro Plumbing & Drain",
  phone: "+14045550000",
  features: { voiceAiEnabled: true },
  voiceSettings,
});

test("normalizes provider and stored phone formats without inventing numbers", () => {
  assert.equal(normalizePhoneToE164("(404) 555-0123"), "+14045550123");
  assert.equal(isUsableCallerId("anonymous"), false);
  assert.equal(isUsableCallerId("+00000000000"), false);
  assert.equal(phoneNumbersEqual("404-555-0123", "+14045550123"), true);
  assert.ok(phoneLookupVariants("+14045550123").includes("404-555-0123"));
  assert.equal(
    extractPhoneNumber("I am at 123 Main Street, ZIP 30303, around 4:30"),
    "",
  );
  assert.equal(
    extractPhoneNumber("Call me at (404) 555-0199, ZIP 30303"),
    "+14045550199",
  );
  assert.equal(extractPostalCode("The ZIP is 30303"), "30303");
});

test("explicit human requests are not swallowed by booking wording", () => {
  assert.equal(isHumanRequest("I want a person to book the appointment"), true);
  assert.equal(isHumanRequest("Can you tell me the business hours?"), false);
});

test("spoken output converts SMS wording, times and ZIP codes", () => {
  const reply = toSpokenReply("Reply YES by SMS for ZIP 30303 at 17:30.");
  assert.match(reply, /Say yes/i);
  assert.match(reply, /by text/i);
  assert.match(reply, /5:30 p\.m\./i);
  assert.match(reply, /3 0 3 0 3/);
});

test("normalization applies dynamic greeting and hard duration limits", () => {
  const settings = normalizeVoiceSettings(
    business({
      answerMode: "overflow",
      overflowRingSeconds: 60,
      maxCallDurationSeconds: 3600,
      welcomeGreeting: "Thanks for calling. How can I help you today?",
    }),
  );
  assert.equal(settings.overflowRingSeconds, 25);
  assert.equal(settings.maxCallDurationSeconds, 600);
  assert.equal(
    settings.resolvedWelcomeGreeting,
    "Thanks for calling Atlanta Pro Plumbing & Drain. This is their automated assistant. How can I help you today?",
  );
});

test("ConversationRelay and staff dialing carry scoped safety controls", () => {
  const relay = conversationRelayTwiml({
    websocketUrl: "wss://voice.example.com/ws/voice",
    businessName: "Bell & Sons <Plumbing>",
    voiceSessionId: "session-1",
    businessId: "business-1",
    providerCallSid: "CA123",
  });
  assert.match(relay, /Bell &amp; Sons &lt;Plumbing&gt;/);
  assert.match(relay, /name="voiceSessionId" value="session-1"/);
  assert.match(relay, /dtmfDetection="true"/);

  const dial = dialTwiml({
    phone: "404-555-0123",
    timeoutSeconds: 20,
    actionPath: "/api/twilio/voice-overflow?fallback=voice_ai",
    screeningPath: "/api/twilio/voice-staff-screen?purpose=initialStaff",
    providerCallSid: "CA123",
  });
  assert.match(dial, /answerOnBridge="true"/);
  assert.match(dial, /voice-staff-screen/);
  assert.match(staffScreenPromptTwiml(), /Press 1 to accept/);
});
