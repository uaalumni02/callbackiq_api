import { activateVoiceSession } from "../../src/voice/activateVoiceSession.js";
import { assertProviderEntitlement } from "../../src/services/providerEntitlement.service.js";
jest.mock("../../src/services/providerEntitlement.service.js", () => ({
  assertProviderEntitlement: jest.fn().mockResolvedValue({ allowed: true }),
}));
const fixture = (values = {}) => {
  const session = {
    _id: "session-a",
    business: { _id: "tenant-a" },
    callLog: { _id: "log-a" },
    providerCallSid: "CA_SYNTHETIC",
    providerSessionId: "VS_SYNTHETIC",
    status: "connecting",
    ...values,
  };
  const populate = jest.fn().mockResolvedValue(session);
  const VoiceSession = {
    findById: jest.fn().mockResolvedValue(session),
    findByIdAndUpdate: jest.fn(() => ({ populate })),
  };
  const deps = {
    VoiceSession,
    populateSession: async (value) => value,
    TERMINAL_STATUSES: new Set(["completed", "failed", "canceled"]),
    normalizePhoneToE164: (value) =>
      /^\+1\d{10}$/.test(value || "") ? value : null,
    recordCallAnswer: jest.fn(),
  };
  const setup = {
    callSid: "CA_SYNTHETIC",
    sessionId: "VS_SYNTHETIC",
    customParameters: { businessId: "tenant-a" },
    from: "+14045550101",
    to: "+14045550102",
  };
  return {
    session,
    deps,
    setup,
    run: (changes) =>
      activateVoiceSession(
        { voiceSessionId: session._id, setup: { ...setup, ...changes } },
        deps,
      ),
  };
};
beforeEach(() =>
  assertProviderEntitlement.mockResolvedValue({ allowed: true }),
);
test.each([
  [{}, { callSid: "CA_OTHER" }, /CallSid/],
  [{}, { customParameters: { businessId: "tenant-b" } }, /business scope/],
  [{ status: "completed" }, {}, /terminal/],
  [{}, { sessionId: "VS_OTHER" }, /SessionId/],
])(
  "B04 relay identity failure never records an answer or mutates the session: %p",
  async (values, changes, error) => {
    const f = fixture(values);
    await expect(f.run(changes)).rejects.toThrow(error);
    expect(f.deps.recordCallAnswer).not.toHaveBeenCalled();
    expect(f.deps.VoiceSession.findByIdAndUpdate).not.toHaveBeenCalled();
  },
);
test("B04 deleted or newly ineligible sessions cannot activate", async () => {
  const f = fixture();
  f.deps.VoiceSession.findById.mockResolvedValue(null);
  await expect(f.run()).rejects.toThrow("not found");
  const active = fixture();
  assertProviderEntitlement.mockRejectedValueOnce(new Error("inactive"));
  await expect(active.run()).rejects.toThrow("inactive");
  expect(active.deps.recordCallAnswer).not.toHaveBeenCalled();
});
test.each(["routing", "connecting", "active"])(
  "B04 valid %s setup preserves identity and records exactly one answer",
  async (status) => {
    const f = fixture({ status });
    await f.run({
      accountSid: "AC_SYNTHETIC",
      callType: "inbound",
      direction: "inbound",
    });
    expect(f.deps.recordCallAnswer).toHaveBeenCalledWith({
      businessId: "tenant-a",
      callLogId: "log-a",
      answeredBy: "ai",
    });
    expect(f.deps.VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith(
      "session-a",
      {
        $set: expect.objectContaining({
          status: "active",
          providerSessionId: "VS_SYNTHETIC",
          from: "+14045550101",
          to: "+14045550102",
        }),
      },
      { returnDocument: "after" },
    );
  },
);
test("B04 repeated setup with raw IDs and invalid optional numbers retains saved identity", async () => {
  const f = fixture({
    business: "tenant-a",
    callLog: "log-a",
    status: "active",
  });
  await f.run({
    sessionId: "",
    from: "garbled",
    to: "",
    customParameters: undefined,
  });
  const update = f.deps.VoiceSession.findByIdAndUpdate.mock.calls[0][1].$set;
  expect(update.providerSessionId).toBe("VS_SYNTHETIC");
  expect(update).not.toHaveProperty("from");
  expect(update).not.toHaveProperty("to");
});
