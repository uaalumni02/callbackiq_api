import { createRecoveryIntroductionJob } from "../../src/services/messaging/recoveryIntroductionJob.js";
import { readProviderEntitlement } from "../../src/services/providerEntitlement.service.js";
jest.mock("../../src/services/providerEntitlement.service.js", () => ({
  readProviderEntitlement: jest.fn(),
}));
const fixture = (change = {}) => {
  const values = {
    business: { _id: "business", isActive: true },
    conversation: {
      _id: "conversation",
      customerPhone: "+15555550100",
      status: "open",
      aiEnabled: true,
    },
    lead: { _id: "lead" },
    callLog: { _id: "log" },
    ...change,
  };
  const deps = {
    Business: { findById: jest.fn(async () => values.business) },
    Conversation: { findOne: jest.fn(async () => values.conversation) },
    Lead: { findOne: jest.fn(async () => values.lead) },
    CallLog: { findOne: jest.fn(async () => values.callLog) },
    isBusinessFeatureEnabled: jest.fn(() => true),
    deliverRecoveryIntroduction: jest.fn().mockResolvedValue({ sent: true }),
    buildMissedCallRecoveryText: () => "Synthetic recovery",
  };
  const payload = {
    businessId: "business",
    conversationId: "conversation",
    leadId: "lead",
    callLogId: "log",
    callSid: "CA_SYNTHETIC",
    from: "+15555550101",
  };
  return {
    values,
    deps,
    payload,
    run: () => createRecoveryIntroductionJob(deps)(payload),
  };
};
beforeEach(() => readProviderEntitlement.mockResolvedValue({ allowed: true }));
test("B04 active queued recovery is tenant-scoped and retains durable provider idempotency inputs", async () => {
  const f = fixture();
  await expect(f.run()).resolves.toEqual({ sent: true });
  expect(f.deps.Conversation.findOne).toHaveBeenCalledWith({
    _id: "conversation",
    business: "business",
  });
  expect(f.deps.deliverRecoveryIntroduction).toHaveBeenCalledWith(
    expect.objectContaining({
      business: f.values.business,
      callSid: "CA_SYNTHETIC",
      customerPhone: "+15555550100",
      strict: true,
      numberContext: { trackingNumber: { phoneNumber: "+15555550101" } },
    }),
  );
});
test.each(["business", "conversation", "lead", "callLog"])(
  "B04 missing queued %s requires reconciliation before any send",
  async (key) => {
    const f = fixture({ [key]: null });
    await expect(f.run()).rejects.toMatchObject({
      code: "RECOVERY_RECORD_MISSING",
    });
    expect(f.deps.deliverRecoveryIntroduction).not.toHaveBeenCalled();
  },
);
test.each([
  { business: { isActive: false } },
  { conversation: { humanTakeover: true } },
  { conversation: { aiEnabled: false } },
  { conversation: { status: "closed" } },
  { conversation: { status: "archived" } },
  {
    callLog: { missedCallTextSent: true, smsProviderMessageId: "SM_SYNTHETIC" },
  },
])("B04 obsolete queue state never resends: %p", async (change) => {
  const f = fixture(change);
  await f.run();
  expect(f.deps.deliverRecoveryIntroduction).not.toHaveBeenCalled();
});
test("B04 subscription or feature changes while queued suppress dispatch", async () => {
  const f = fixture();
  readProviderEntitlement.mockResolvedValueOnce({ allowed: false });
  await f.run();
  expect(f.deps.deliverRecoveryIntroduction).not.toHaveBeenCalled();
  f.deps.isBusinessFeatureEnabled.mockReturnValue(false);
  await f.run();
  expect(f.deps.deliverRecoveryIntroduction).not.toHaveBeenCalled();
});
test("B04 uncertain provider outcomes propagate for durable reconciliation without a second send", async () => {
  const f = fixture(),
    error = Object.assign(new Error("synthetic unknown outcome"), {
      code: "SMS_DELIVERY_RECONCILIATION_REQUIRED",
    });
  f.deps.deliverRecoveryIntroduction.mockRejectedValue(error);
  await expect(f.run()).rejects.toBe(error);
  expect(f.deps.deliverRecoveryIntroduction).toHaveBeenCalledTimes(1);
});
