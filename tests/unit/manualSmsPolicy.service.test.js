import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import { evaluateManualSmsPolicy } from "../../src/services/messaging/manualSmsPolicy.service.js";

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { exists: jest.fn() },
}));

const BUSINESS_ID = "64f000000000000000000001";
const CONVERSATION_ID = "64f000000000000000000002";
const LEAD_ID = "64f000000000000000000003";

beforeEach(() => {
  jest.clearAllMocks();
  Conversation.findOne.mockResolvedValue(null);
  Lead.findOne.mockResolvedValue(null);
  Message.exists.mockResolvedValue(false);
});

test("requires a selected tenant conversation before manual SMS dispatch", async () => {
  const result = await evaluateManualSmsPolicy({
    business: { _id: BUSINESS_ID },
    to: "+14045550199",
    body: "Hello",
  });

  expect(result).toMatchObject({
    allowed: false,
    statusCode: 400,
    reason: "conversation_required",
  });
  expect(Conversation.findOne).not.toHaveBeenCalled();
});

test("blocks sensitive credentials and payment-card content", async () => {
  const result = await evaluateManualSmsPolicy({
    business: { _id: BUSINESS_ID },
    to: "+14045550199",
    body: "My password: Secret123 and card 4111 1111 1111 1111",
  });

  expect(result).toMatchObject({
    allowed: false,
    reason: "sensitive_data",
  });
  expect(Conversation.findOne).not.toHaveBeenCalled();
});

test("allows a recent customer response and marks it as direct-response traffic", async () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const conversation = {
    _id: CONVERSATION_ID,
    business: BUSINESS_ID,
    lead: LEAD_ID,
    customerPhone: "+14045550199",
  };
  Conversation.findOne.mockResolvedValue(conversation);
  Lead.findOne.mockResolvedValue({ _id: LEAD_ID, business: BUSINESS_ID });
  Message.exists.mockResolvedValue(true);

  const result = await evaluateManualSmsPolicy({
    business: { _id: BUSINESS_ID },
    conversationId: CONVERSATION_ID,
    to: "+14045550199",
    body: "We received your message and will call shortly.",
    now,
  });

  expect(result).toMatchObject({
    allowed: true,
    normalizedTo: "+14045550199",
    directResponse: true,
    conversation,
  });
  expect(Message.exists).toHaveBeenCalledWith(
    expect.objectContaining({
      business: BUSINESS_ID,
      conversation: CONVERSATION_ID,
      direction: "inbound",
    }),
  );
});

test("blocks a conversation id paired with a different destination", async () => {
  Conversation.findOne.mockResolvedValue({
    _id: CONVERSATION_ID,
    business: BUSINESS_ID,
    customerPhone: "+14045550100",
    lead: LEAD_ID,
  });

  const result = await evaluateManualSmsPolicy({
    business: { _id: BUSINESS_ID },
    conversationId: CONVERSATION_ID,
    to: "+14045550199",
    body: "Hello from the team.",
  });

  expect(result).toMatchObject({
    allowed: false,
    statusCode: 409,
    reason: "conversation_destination_mismatch",
  });
  expect(Lead.findOne).toHaveBeenCalledTimes(1);
  expect(Message.exists).not.toHaveBeenCalled();
});
