import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import SocketService from "../../src/services/socket.service.js";
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
jest.mock("../../src/voice/voicePhone.service.js", () => ({
  __esModule: true,
  phoneLookupVariants: jest.fn((phone) => [phone]),
}));
jest.mock("../../src/services/messaging/smsCompliance.service.js", () => ({
  __esModule: true,
  normalizeSmsPhone: jest.fn((phone) => String(phone || "").trim()),
}));

const business = {
  _id: "b1",
  estimatedJobValue: 1200,
};

const lead = {
  _id: "l1",
  customerName: "Customer",
  phone: "+14705550111",
  phoneLookup: "+14705550111",
  status: "contacted",
  notes: "Historical customer context",
};

const makeConversation = (recoveryJourneyKey) => ({
  _id: "c1",
  lead: "l1",
  customerPhone: "+14705550111",
  customerPhoneLookup: "+14705550111",
  status: "open",
  activeRecord: true,
  aiEnabled: true,
  humanTakeover: false,
  lastMessage: "old message",
  bookingState: {
    status: "collecting_preference",
    serviceOffering: "service-old",
    streetAddress: "123 Old St",
    postalCode: "30303",
    offeredSlots: [
      {
        startAt: new Date("2026-09-05T13:00:00.000Z"),
        endAt: new Date("2026-09-05T14:00:00.000Z"),
      },
    ],
    negotiationAttempts: 2,
  },
  orchestration: {
    recoveryJourneyKey,
    phase: "scheduling",
  },
});

const arrange = (conversation) => {
  Lead.findOne.mockReturnValue({
    sort: jest.fn().mockResolvedValue(lead),
  });
  Conversation.findOne.mockReturnValue({
    sort: jest.fn().mockResolvedValue(conversation),
  });
  Conversation.findByIdAndUpdate.mockImplementation(async (_id, updates) => ({
    ...conversation,
    ...updates,
  }));
};

describe("SMS missed-call recovery journey identity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("a new CallSid resets only active booking/recovery state", async () => {
    arrange(makeConversation("CA-old"));

    await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: "+14705550111",
      source: "missed_call",
      reopenEligible: true,
      recoveryJourneyKey: "CA-new",
    });

    const [, updates] = Conversation.findByIdAndUpdate.mock.calls[0];
    expect(updates).toMatchObject({
      reopenReason: "new_missed_call_recovery_journey",
      "bookingState.status": "not_started",
      "bookingState.serviceOffering": null,
      "bookingState.streetAddress": "",
      "bookingState.postalCode": "",
      "bookingState.offeredSlots": [],
      "bookingState.negotiationAttempts": 0,
      "orchestration.recoveryJourneyKey": "CA-new",
      "orchestration.phase": "recovering",
    });
  });

  test("a retry of the same CallSid does not reset the active booking state again", async () => {
    arrange(makeConversation("CA-same"));

    await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: "+14705550111",
      source: "missed_call",
      reopenEligible: true,
      recoveryJourneyKey: "CA-same",
    });

    const [, updates] = Conversation.findByIdAndUpdate.mock.calls[0];
    expect(updates["bookingState.status"]).toBeUndefined();
    expect(updates["orchestration.recoveryJourneyKey"]).toBeUndefined();
  });
});
