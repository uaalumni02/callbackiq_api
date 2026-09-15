jest.setTimeout(120000);

jest.mock("../../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitLeadCreated: jest.fn(),
    emitConversationCreated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitCallCreated: jest.fn(),
    emitAlertCreated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

jest.mock("../../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: jest.fn(async () => ({ _id: "voice-concurrency-alert" })),
  },
}));

jest.mock("../../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));

jest.mock("../../../src/services/messaging/contactPreference.service.js", () => ({
  __esModule: true,
  isSmsSuppressed: jest.fn(async () => false),
}));

jest.mock("../../../src/services/voiceTurnContext.service.js", () => ({
  __esModule: true,
  assertVoiceTurnActive: jest.fn(),
}));

import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import Alert from "../../../src/models/alert.js";
import Appointment from "../../../src/models/appointment.js";
import Business from "../../../src/models/business.js";
import CallLog from "../../../src/models/callLog.js";
import Conversation from "../../../src/models/conversation.js";
import Lead from "../../../src/models/lead.js";
import VoiceCapacity from "../../../src/models/voiceCapacity.js";
import VoiceSession from "../../../src/models/voiceSession.js";

import VoiceHandoffService from "../../../src/voice/voiceHandoff.service.js";
import VoiceSessionService from "../../../src/voice/voiceSession.service.js";
import VoiceTranscriptService from "../../../src/voice/voiceTranscript.service.js";
import {
  acquireVoiceCapacity,
  releaseVoiceCapacity,
  sweepExpiredVoiceCapacity,
} from "../../../src/services/voiceCapacity.service.js";
import { classifyTransferAcceptance } from "../../../src/voice/voiceTransferGuard.service.js";

import {
  acquireAll,
  appendSentinelTurn,
  createConcurrencyBusiness,
  establishCalls,
  releaseAll,
} from "./helpers/concurrentVoiceHarness.js";
import {
  buildSyntheticCall,
  callerFor,
} from "./helpers/syntheticCallFactory.js";
import {
  findTranscriptContamination,
  uniqueStrings,
} from "./helpers/voiceAssertions.js";

const clearDatabase = async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
};

const refreshedSessions = (business) =>
  VoiceSession.find({ business: business._id }).sort({ providerCallSid: 1 }).lean();

describe("Voice Concurrency Certification", () => {
  let replSet;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.VOICE_CAPACITY_FAIL_CLOSED = "true";

    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri());

    await Promise.all([
      Business.init(),
      Lead.init(),
      Conversation.init(),
      CallLog.init(),
      VoiceSession.init(),
      VoiceCapacity.init(),
      Alert.init(),
      Appointment.init(),
    ]);
  }, 90000);

  afterEach(async () => {
    await clearDatabase();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  }, 90000);

  test.each([2, 10, 20])(
    "%i different simultaneous callers remain completely isolated",
    async (count) => {
      const business = await createConcurrencyBusiness({ maxConcurrentCalls: 25 });
      const calls = Array.from({ length: count }, (_, index) =>
        buildSyntheticCall({ index, namespace: `different-${count}` }),
      );

      const sessions = await establishCalls({ business, calls });

      expect(sessions).toHaveLength(count);
      expect(uniqueStrings(sessions.map((session) => session._id))).toBe(count);
      expect(uniqueStrings(sessions.map((session) => session.providerCallSid))).toBe(count);
      expect(uniqueStrings(sessions.map((session) => session.providerSessionId))).toBe(count);
      expect(uniqueStrings(sessions.map((session) => session.lead))).toBe(count);
      expect(uniqueStrings(sessions.map((session) => session.conversation))).toBe(count);
      expect(uniqueStrings(sessions.map((session) => session.callLog))).toBe(count);
      expect(await Lead.countDocuments({ business: business._id })).toBe(count);
      expect(await Conversation.countDocuments({ business: business._id })).toBe(count);
      expect(await CallLog.countDocuments({ business: business._id })).toBe(count);

      await Promise.all(
        sessions.map((session, index) =>
          appendSentinelTurn({ session, call: calls[index] }),
        ),
      );

      const acquisitions = await acquireAll({ business, sessions });
      expect(acquisitions.filter((result) => result.allowed)).toHaveLength(count);

      const capacity = await VoiceCapacity.findOne({ business: business._id }).lean();
      expect(capacity?.leases).toHaveLength(count);
      expect(uniqueStrings(capacity.leases.map((lease) => lease.key))).toBe(count);

      const stored = await refreshedSessions(business);
      expect(findTranscriptContamination({ sessions: stored, calls })).toEqual([]);
      expect(stored.every((session) => session.status === "active")).toBe(true);

      await releaseAll({ business, sessions });
      const released = await VoiceCapacity.findOne({ business: business._id }).lean();
      expect(released?.leases || []).toHaveLength(0);
    },
    60000,
  );

  test("1001 businesses retain isolation during 350 parallel voice contexts", async () => {
    const businesses = [];
    for (let start = 0; start < 1001; start += 25) businesses.push(...await Promise.all(
      Array.from({ length: Math.min(25, 1001 - start) }, (_, i) => createConcurrencyBusiness({ phone: `+1${String(2020000000 + start + i)}` }))));
    const calls = Array.from({ length: 350 }, (_, index) => ({ ...buildSyntheticCall({ index, namespace: 'fleet-350' }), to: businesses[index].phone }));
    const sessions = await Promise.all(calls.map(async (call, index) => {
      const business = businesses[index];
      const [session] = await establishCalls({ business, calls: [call] });
      await appendSentinelTurn({ session, call });
      const [capacity] = await acquireAll({ business, sessions: [session] });
      expect(capacity.allowed).toBe(true);
      return session;
    }));
    expect(await Business.countDocuments()).toBe(1001);
    expect(uniqueStrings(sessions.map(x => x.business))).toBe(350);
    expect(await VoiceSession.countDocuments({ status: 'active' })).toBe(350);
    const stored = await VoiceSession.find().lean();
    expect(findTranscriptContamination({ sessions: stored, calls })).toEqual([]);
    for (let i = 0; i < sessions.length; i++) {
      expect(String((await Lead.findById(sessions[i].lead)).business)).toBe(String(businesses[i]._id));
      expect(String((await Conversation.findById(sessions[i].conversation)).business)).toBe(String(businesses[i]._id));
    }
    await Promise.all(sessions.map((session, i) => releaseAll({ business: businesses[i], sessions: [session] })));
    expect(await VoiceCapacity.countDocuments({ 'leases.0': { $exists: true } })).toBe(0);
  }, 180000);

  test("capacity boundary atomically admits exactly two of three calls", async () => {
    const business = await createConcurrencyBusiness({ maxConcurrentCalls: 2 });
    const calls = Array.from({ length: 3 }, (_, index) =>
      buildSyntheticCall({ index, namespace: "capacity-boundary" }),
    );
    const sessions = await establishCalls({ business, calls });

    const acquisitions = await acquireAll({ business, sessions });
    const acceptedIndexes = acquisitions
      .map((result, index) => (result.allowed ? index : -1))
      .filter((index) => index >= 0);
    const rejectedIndexes = acquisitions
      .map((result, index) => (!result.allowed ? index : -1))
      .filter((index) => index >= 0);

    expect(acceptedIndexes).toHaveLength(2);
    expect(rejectedIndexes).toHaveLength(1);
    expect(acquisitions[rejectedIndexes[0]]).toMatchObject({
      allowed: false,
      reason: "voice_concurrency_limit",
      maximum: 2,
    });

    const capacity = await VoiceCapacity.findOne({ business: business._id }).lean();
    const acceptedKeys = acceptedIndexes.map((index) => calls[index].callSid).sort();
    expect(capacity.leases.map((lease) => lease.key).sort()).toEqual(acceptedKeys);
    expect(capacity.leases.some((lease) => lease.key === calls[rejectedIndexes[0]].callSid)).toBe(false);

    await Promise.all(
      acceptedIndexes.map((index) =>
        appendSentinelTurn({ session: sessions[index], call: calls[index] }),
      ),
    );
    const stored = await refreshedSessions(business);
    const acceptedCalls = acceptedIndexes.map((index) => calls[index]);
    const acceptedSessions = stored.filter((session) => acceptedKeys.includes(session.providerCallSid));
    expect(findTranscriptContamination({ sessions: acceptedSessions, calls: acceptedCalls })).toEqual([]);
    expect(acceptedSessions.every((session) => session.status === "active")).toBe(true);

    await releaseAll({
      business,
      sessions: acceptedIndexes.map((index) => sessions[index]),
    });
  });

  test("same caller can place two simultaneous first-time calls without live-state crossover", async () => {
    const business = await createConcurrencyBusiness({ maxConcurrentCalls: 5 });
    const sharedCaller = callerFor(900);
    const calls = [
      buildSyntheticCall({ index: 1, namespace: "same-caller", from: sharedCaller, service: "leaking faucet" }),
      buildSyntheticCall({ index: 2, namespace: "same-caller", from: sharedCaller, service: "overflowing toilet" }),
    ];

    const results = await Promise.allSettled(
      calls.map((call) =>
        VoiceSessionService.ensureContext({
          business,
          from: call.from,
          to: call.to,
          providerCallSid: call.callSid,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);

    const contexts = results.map((result) => result.value);
    await Promise.all(
      contexts.map((context, index) =>
        VoiceSessionService.activateFromSetup({
          voiceSessionId: context._id,
          setup: {
            callSid: calls[index].callSid,
            sessionId: calls[index].providerSessionId,
            accountSid: "AC00000000000000000000000000000000",
            from: sharedCaller,
            to: calls[index].to,
            direction: "inbound",
            callType: "PSTN",
            customParameters: { businessId: String(business._id) },
          },
        }),
      ),
    );

    const sessions = await Promise.all(
      calls.map((call) =>
        VoiceSession.findOne({ business: business._id, providerCallSid: call.callSid }),
      ),
    );

    expect(await VoiceSession.countDocuments({ business: business._id })).toBe(2);
    expect(await CallLog.countDocuments({ business: business._id })).toBe(2);
    expect(await Lead.countDocuments({ business: business._id })).toBe(1);
    expect(await Conversation.countDocuments({ business: business._id })).toBe(1);
    expect(uniqueStrings(sessions.map((session) => session._id))).toBe(2);
    expect(uniqueStrings(sessions.map((session) => session.callLog))).toBe(2);
    expect(uniqueStrings(sessions.map((session) => session.lead))).toBe(1);
    expect(uniqueStrings(sessions.map((session) => session.conversation))).toBe(1);

    await Promise.all(
      sessions.map((session, index) =>
        appendSentinelTurn({ session, call: calls[index] }),
      ),
    );

    const stored = await refreshedSessions(business);
    expect(findTranscriptContamination({ sessions: stored, calls })).toEqual([]);
    expect(uniqueStrings(stored.map((session) => session.providerSessionId))).toBe(2);
  });

  test("ending one call releases only its own lease and the survivor keeps working", async () => {
    const business = await createConcurrencyBusiness({ maxConcurrentCalls: 5 });
    const calls = [
      buildSyntheticCall({ index: 1, namespace: "selective-hangup" }),
      buildSyntheticCall({ index: 2, namespace: "selective-hangup" }),
    ];
    const sessions = await establishCalls({ business, calls });
    const acquisitions = await acquireAll({ business, sessions });
    expect(acquisitions.every((result) => result.allowed)).toBe(true);

    await VoiceSessionService.markCompleted(sessions[0]._id, { reason: "synthetic_hangup" });
    await releaseVoiceCapacity({ businessId: business._id, session: sessions[0] });

    let capacity = await VoiceCapacity.findOne({ business: business._id }).lean();
    expect(capacity.leases).toHaveLength(1);
    expect(capacity.leases[0].key).toBe(calls[1].callSid);

    await VoiceTranscriptService.append({
      sessionId: sessions[1]._id,
      role: "customer",
      text: `${calls[1].sentinel} SURVIVOR_CHECK_481`,
    });

    const ended = await VoiceSession.findById(sessions[0]._id).lean();
    const survivor = await VoiceSession.findById(sessions[1]._id).lean();
    expect(ended.status).toBe("completed");
    expect(survivor.status).toBe("active");
    expect(survivor.transcript.some((entry) => entry.text.includes("SURVIVOR_CHECK_481"))).toBe(true);

    await releaseVoiceCapacity({ businessId: business._id, session: sessions[1] });
    capacity = await VoiceCapacity.findOne({ business: business._id }).lean();
    expect(capacity.leases).toHaveLength(0);
  });

  test("expired crash-orphan leases are swept without removing a live lease", async () => {
    const business = await createConcurrencyBusiness({ maxConcurrentCalls: 2 });
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 5 * 60_000);
    const liveUntil = new Date(now.getTime() + 5 * 60_000);

    await VoiceCapacity.create({
      business: business._id,
      leases: [
        { key: "CA_CRASH_1", sessionId: new mongoose.Types.ObjectId(), acquiredAt: expiredAt, expiresAt: expiredAt },
        { key: "CA_CRASH_2", sessionId: new mongoose.Types.ObjectId(), acquiredAt: expiredAt, expiresAt: expiredAt },
        { key: "CA_LIVE", sessionId: new mongoose.Types.ObjectId(), acquiredAt: now, expiresAt: liveUntil },
      ],
    });

    const result = await sweepExpiredVoiceCapacity({ now });
    expect(result.modifiedCount).toBe(1);

    let capacity = await VoiceCapacity.findOne({ business: business._id }).lean();
    expect(capacity.leases.map((lease) => lease.key)).toEqual(["CA_LIVE"]);

    const replacement = {
      _id: new mongoose.Types.ObjectId(),
      providerCallSid: "CA_AFTER_CRASH",
    };
    const acquisition = await acquireVoiceCapacity({ business, session: replacement });
    expect(acquisition.allowed).toBe(true);

    capacity = await VoiceCapacity.findOne({ business: business._id }).lean();
    expect(capacity.leases.map((lease) => lease.key).sort()).toEqual([
      "CA_AFTER_CRASH",
      "CA_LIVE",
    ]);

    await releaseVoiceCapacity({ businessId: business._id, session: replacement });
  });

  test("two simultaneous handoffs preserve independent session and downstream outcomes", async () => {
    const business = await createConcurrencyBusiness({ maxConcurrentCalls: 5 });
    const calls = [
      buildSyntheticCall({ index: 1, namespace: "transfer-a", service: "water heater" }),
      buildSyntheticCall({ index: 2, namespace: "transfer-b", service: "air conditioner" }),
    ];
    await establishCalls({ business, calls });

    const sessions = await Promise.all(
      calls.map((call) =>
        VoiceSession.findOne({ business: business._id, providerCallSid: call.callSid })
          .populate(["business", "lead", "conversation", "callLog"]),
      ),
    );

    const [handoffA, handoffB] = await Promise.all([
      VoiceHandoffService.request({
        session: sessions[0],
        reason: "concurrency_transfer_alpha",
        customerMessage: "TRANSFER_ALPHA customer requested a person",
      }),
      VoiceHandoffService.request({
        session: sessions[1],
        reason: "concurrency_transfer_bravo",
        customerMessage: "TRANSFER_BRAVO customer requested a person",
      }),
    ]);

    const dataA = JSON.parse(handoffA.handoffData);
    const dataB = JSON.parse(handoffB.handoffData);
    expect(dataA.voiceSessionId).toBe(String(sessions[0]._id));
    expect(dataB.voiceSessionId).toBe(String(sessions[1]._id));
    expect(dataA.voiceSessionId).not.toBe(dataB.voiceSessionId);

    const stored = await refreshedSessions(business);
    const bySid = new Map(stored.map((session) => [session.providerCallSid, session]));
    expect(bySid.get(calls[0].callSid)).toMatchObject({
      status: "transferring",
      transferredToHuman: false,
      transferReason: "concurrency_transfer_alpha",
    });
    expect(bySid.get(calls[1].callSid)).toMatchObject({
      status: "transferring",
      transferredToHuman: false,
      transferReason: "concurrency_transfer_bravo",
    });

    const conversations = await Promise.all(
      sessions.map((session) => Conversation.findById(session.conversation._id).lean()),
    );
    expect(conversations[0].lastMessage).toContain("TRANSFER_ALPHA");
    expect(conversations[0].lastMessage).not.toContain("TRANSFER_BRAVO");
    expect(conversations[1].lastMessage).toContain("TRANSFER_BRAVO");
    expect(conversations[1].lastMessage).not.toContain("TRANSFER_ALPHA");

    expect(await Alert.countDocuments({ business: business._id })).toBe(2);

    const downstreamA = classifyTransferAcceptance({
      answeredBy: "human",
      digits: "1",
      dialCallStatus: "completed",
    });
    const downstreamB = classifyTransferAcceptance({
      answeredBy: "human",
      digits: "",
      dialCallStatus: "busy",
    });
    expect(downstreamA).toEqual({ accepted: true, reason: "agent_confirmed" });
    expect(downstreamB).toEqual({ accepted: false, reason: "transfer_busy" });
  });

  test("concurrent duplicate delivery of one CallSid remains idempotent", async () => {
    const business = await createConcurrencyBusiness({ maxConcurrentCalls: 5 });
    const call = buildSyntheticCall({ index: 77, namespace: "same-callsid" });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        VoiceSessionService.ensureContext({
          business,
          from: call.from,
          to: call.to,
          providerCallSid: call.callSid,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(await VoiceSession.countDocuments({ business: business._id, providerCallSid: call.callSid })).toBe(1);
    expect(await CallLog.countDocuments({ business: business._id, providerCallId: call.callSid })).toBe(1);
    expect(await Lead.countDocuments({ business: business._id })).toBe(1);
    expect(await Conversation.countDocuments({ business: business._id })).toBe(1);
  });
});
