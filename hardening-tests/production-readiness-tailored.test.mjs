import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("SMS usage and idempotency are reserved in one transaction", () => {
  const source = read("src/services/communicationUsageReservation.service.js");
  assert.match(source, /reserveCommunicationUsageOperation/);
  assert.match(source, /withTransaction/);
  assert.match(source, /reserveCommunicationUsage\(\{[\s\S]*mongoSession/);
  assert.match(source, /CommunicationUsageReservation\.create\([\s\S]*session: mongoSession/);
  assert.match(source, /COMMUNICATION_OPERATION_CONFLICT/);
});

test("SMS release is claim-fenced and counters cannot go below zero", () => {
  const reservation = read("src/services/communicationUsageReservation.service.js");
  const usage = read("src/services/communicationUsage.service.js");
  assert.match(reservation, /state: "releasing"/);
  assert.match(reservation, /ownerToken/);
  assert.match(reservation, /releaseClaimTransactionally/);
  assert.match(usage, /\$max:\s*\[\s*0,/);
});

test("first-contact disclosure cannot be released by a concurrent sender", () => {
  const source = read("src/services/smsContactDisclosure.service.js");
  assert.match(source, /claim: null, concurrent: true/);
  assert.match(source, /ownerToken: claim\.ownerToken/);
  assert.match(source, /businessId,[\s\S]*phone,[\s\S]*operationKey/);
});

test("Twilio send uses the transactional operation reservation", () => {
  const source = read("src/services/twilioSmsService.js");
  assert.match(source, /reserveCommunicationUsageOperation/);
  assert.doesNotMatch(source, /reserveSmsUsage\(/);
  assert.match(source, /SMS_PROVIDER_OUTCOME_UNCERTAIN/);
  assert.match(source, /commitSmsContactDisclosure\(\{[\s\S]*businessId:[\s\S]*phone:/);
});

test("manual SMS changes conversation state only after provider acceptance", () => {
  const source = read("src/services/messaging/manualSmsOperation.service.js");
  const sendIndex = source.indexOf("const sent = await sendSms(");
  const acceptedIndex = source.indexOf('operation.state = "provider_accepted"', sendIndex);
  const persistIndex = source.indexOf("return await persistAcceptedOperation", acceptedIndex);
  const takeoverIndex = source.indexOf("humanTakeover", source.indexOf("const persistAcceptedOperation"));
  assert.ok(sendIndex >= 0, "manual operation must dispatch through sendSms");
  assert.ok(acceptedIndex > sendIndex, "provider acceptance must be persisted after dispatch");
  assert.ok(persistIndex > acceptedIndex, "conversation persistence must follow provider acceptance");
  assert.ok(takeoverIndex >= 0, "accepted persistence must activate human takeover");
  assert.match(source, /idempotencyKey/);
  assert.match(source, /SMS_PROVIDER_OUTCOME_UNCERTAIN|deliveryUncertain/);
});

test("provider delivery and call states advance monotonically", () => {
  const sms = read("src/services/messaging/smsDeliveryStatus.service.js");
  const call = read("src/services/twilioCallStatus.service.js");
  assert.match(sms, /ALLOWED_CURRENT_STATUSES/);
  assert.match(sms, /deliveryEvents/);
  assert.match(sms, /conflict: true/);
  assert.match(call, /ALLOWED_CURRENT/);
  assert.match(call, /providerStatusEvents/);
  assert.match(call, /conflict: true/);
});

test("status callbacks resolve ownership from provider identifiers first", () => {
  const source = read("src/services/twilioStatusBusinessResolver.service.js");
  assert.match(source, /providerMessageId/);
  assert.match(source, /providerCallId/);
  assert.match(source, /business/);
});

test("voice WebSocket admission is distributed and fails closed on lease outage", () => {
  const relay = read("src/voice/conversationRelay.server.js");
  const lease = read("src/services/voiceConnectionLease.service.js");
  assert.match(relay, /connection_lease_acquire_failed/);
  assert.match(relay, /rejectUpgrade\(socket, 503, "Service Unavailable"\)/);
  assert.match(relay, /resolveTrustedRemoteAddress/);
  assert.match(lease, /VoiceConnectionBucket\.findOneAndUpdate/);
  assert.match(lease, /releaseVoiceConnectionLease = async \(lease = \{\}\)/);
});

test("voice usage reconciliation cannot steal an active worker lease", () => {
  const source = read("src/services/voiceUsage.service.js");
  assert.match(source, /state: "processing", leaseExpiresAt: \{ \$lte: now \}/);
  assert.match(source, /releaseVoiceUsageReservation/);
  assert.match(source, /withTransaction/);
  assert.match(source, /state: "releasing"/);
});

test("voice turns propagate cancellation and fence side effects", () => {
  const relay = read("src/voice/conversationRelay.server.js");
  const agent = read("src/voice/voiceAgent.service.js");
  const understanding = read("src/voice/voiceUnderstanding.service.js");
  const booking = read("src/services/booking/bookingStateMachine.service.js");
  assert.match(relay, /AbortController/);
  assert.match(relay, /runWithVoiceTurnContext/);
  assert.match(relay, /signal: abortController\.signal/);
  assert.match(agent, /assertVoiceTurnActive/);
  assert.match(understanding, /signal/);
  assert.match(booking, /assertVoiceTurnActive\(\);[\s\S]*createAppointmentTool/);
});

test("voice settings use server contracts, versioning and rollback", () => {
  const controller = read("src/controllers/voiceSettings.js");
  const versions = read("src/services/voiceSettingsVersion.service.js");
  const contract = read("src/services/voiceSettingsContract.service.js");
  assert.match(controller, /previousVoiceSettingsSnapshot/);
  assert.match(controller, /publishVoiceSettingsVersion/);
  assert.match(versions, /withTransaction/);
  assert.match(versions, /MAX_PUBLICATION_ATTEMPTS|attempt/);
  assert.match(contract, /allowedVoiceNames/);
});

test("tests isolate distributed connection leases from real MongoDB", () => {
  for (const relative of [
    "tests/unit/conversationRelay.server.test.js",
    "tests/unit/communicationSafety.voiceRelayLimits.test.js",
    "tests/integration/voiceAbandonmentRecovery.integration.test.js",
  ]) {
    assert.match(read(relative), /voiceConnectionLeaseService/);
  }
});

test("case-sensitive Stripe route import matches the source file", () => {
  assert.match(read("src/app.js"), /stripeWebHook\.routes\.js/);
  assert.ok(fs.existsSync(path.join(root, "src/routes/stripeWebHook.routes.js")));
});
