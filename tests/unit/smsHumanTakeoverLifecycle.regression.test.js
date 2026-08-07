import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import { getOrCreateSmsLeadAndConversation } from "../../src/services/messaging/smsConversation.service.js";

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitLeadCreated: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitConversationCreated: jest.fn(),
    emitConversationUpdated: jest.fn(),
  },
}));

const PHONE = "+14045550101";
const business = { _id: "business-1", estimatedJobValue: 500 };
const lead = {
  _id: "lead-1",
  phone: PHONE,
  phoneLookup: PHONE,
  status: "contacted",
  notes: "existing lead",
};
const queryResult = (value) => ({ sort: jest.fn().mockResolvedValue(value) });

const arrangeConversation = (overrides = {}) => {
  const conversation = {
    _id: "conversation-1",
    lead: lead._id,
    status: "open",
    aiEnabled: false,
    humanTakeover: true,
    humanTakeoverAt: new Date("2026-08-07T12:00:00.000Z"),
    humanTakeoverBy: "user-1",
    lastMessageAt: new Date("2026-08-07T12:00:00.000Z"),
    customerPhone: PHONE,
    customerPhoneLookup: PHONE,
    ...overrides,
  };

  Lead.findOne.mockReturnValue(queryResult(lead));
  Conversation.findOne.mockReturnValue(queryResult(conversation));
  Conversation.findByIdAndUpdate.mockImplementation(async (_id, updates) => ({
    ...conversation,
    ...updates,
  }));
  return conversation;
};

describe("SMS human takeover lifecycle", () => {
  const originalTtl = process.env.SMS_HUMAN_TAKEOVER_TTL_MINUTES;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-07T14:00:00.000Z"));
    process.env.SMS_HUMAN_TAKEOVER_TTL_MINUTES = "60";
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalTtl == null) delete process.env.SMS_HUMAN_TAKEOVER_TTL_MINUTES;
    else process.env.SMS_HUMAN_TAKEOVER_TTL_MINUTES = originalTtl;
  });

  test("resumes a stale human takeover for a new missed-call recovery", async () => {
    arrangeConversation({
      humanTakeoverAt: new Date("2026-08-07T11:30:00.000Z"),
      lastMessageAt: new Date("2026-08-07T12:30:00.000Z"),
    });

    const { conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: PHONE,
      source: "missed_call",
      reopenEligible: true,
    });

    expect(Conversation.findByIdAndUpdate).toHaveBeenCalledWith(
      "conversation-1",
      expect.objectContaining({
        status: "open",
        aiEnabled: true,
        humanTakeover: false,
        humanTakeoverAt: null,
        humanTakeoverBy: null,
        reopenReason: "new_missed_call_after_stale_human_takeover",
      }),
      expect.objectContaining({ returnDocument: "after" }),
    );
    expect(conversation.aiEnabled).toBe(true);
    expect(conversation.humanTakeover).toBe(false);
  });

  test("preserves a recent human takeover during a new missed call", async () => {
    arrangeConversation({
      humanTakeoverAt: new Date("2026-08-07T13:45:00.000Z"),
      lastMessageAt: new Date("2026-08-07T13:50:00.000Z"),
    });

    await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: PHONE,
      source: "missed_call",
      reopenEligible: true,
    });

    const updates = Conversation.findByIdAndUpdate.mock.calls[0][1];
    expect(updates.aiEnabled).toBeUndefined();
    expect(updates.humanTakeover).toBeUndefined();
    expect(updates.reopenReason).toBeUndefined();
  });

  test("recent customer activity extends the active takeover window", async () => {
    arrangeConversation({
      humanTakeoverAt: new Date("2026-08-07T11:00:00.000Z"),
      lastMessageAt: new Date("2026-08-07T13:50:00.000Z"),
    });

    await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: PHONE,
      source: "missed_call",
      reopenEligible: true,
    });

    const updates = Conversation.findByIdAndUpdate.mock.calls[0][1];
    expect(updates.humanTakeover).toBeUndefined();
    expect(updates.aiEnabled).toBeUndefined();
  });

  test("ordinary inbound SMS does not auto-resume a stale human takeover", async () => {
    arrangeConversation({
      humanTakeoverAt: new Date("2026-08-07T10:00:00.000Z"),
      lastMessageAt: new Date("2026-08-07T10:30:00.000Z"),
    });

    await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: PHONE,
      body: "Are you still there?",
      source: "sms",
      reopenEligible: true,
    });

    const updates = Conversation.findByIdAndUpdate.mock.calls[0][1];
    expect(updates.humanTakeover).toBeUndefined();
    expect(updates.aiEnabled).toBeUndefined();
    expect(updates.reopenReason).toBeUndefined();
  });

  test("fails closed when takeover timestamps are unavailable", async () => {
    arrangeConversation({ humanTakeoverAt: null, lastMessageAt: null });

    await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: PHONE,
      source: "missed_call",
      reopenEligible: true,
    });

    const updates = Conversation.findByIdAndUpdate.mock.calls[0][1];
    expect(updates.humanTakeover).toBeUndefined();
    expect(updates.aiEnabled).toBeUndefined();
  });
});
