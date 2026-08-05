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
  default: { findOne: jest.fn() },
}));

const query = (value) => ({
  sort: jest.fn(() => query(value)),
  select: jest.fn(() => query(value)),
  lean: jest.fn().mockResolvedValue(value),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

beforeEach(() => {
  jest.clearAllMocks();
  Conversation.findOne.mockReturnValue(query(null));
  Lead.findOne.mockReturnValue(query(null));
  Message.findOne.mockReturnValue(query(null));
});

test("blocks arbitrary destinations that are not tied to the tenant", async () => {
  const result = await evaluateManualSmsPolicy({
    business: { _id: "business-1" },
    to: "+14045550199",
    body: "Hello",
  });

  expect(result).toMatchObject({
    allowed: false,
    statusCode: 403,
    reason: "destination_not_customer",
  });
});

test("blocks sensitive credentials and payment-card content", async () => {
  const result = await evaluateManualSmsPolicy({
    business: { _id: "business-1" },
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
    _id: "conversation-1",
    business: "business-1",
    lead: "lead-1",
    customerPhone: "+14045550199",
  };
  Conversation.findOne.mockReturnValue(query(conversation));
  Lead.findOne.mockReturnValue(query({ _id: "lead-1" }));
  Message.findOne.mockReturnValue(
    query({ createdAt: new Date(now.getTime() - 60 * 60 * 1000) }),
  );

  const result = await evaluateManualSmsPolicy({
    business: { _id: "business-1" },
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
});


test("blocks a conversation id paired with a different destination", async () => {
  Conversation.findOne.mockReturnValue(
    query({
      _id: "conversation-1",
      business: "business-1",
      customerPhone: "+14045550100",
      lead: "lead-1",
    }),
  );

  const result = await evaluateManualSmsPolicy({
    business: { _id: "business-1" },
    conversationId: "conversation-1",
    to: "+14045550199",
    body: "Hello from the team.",
  });

  expect(result).toMatchObject({
    allowed: false,
    statusCode: 403,
    reason: "conversation_destination_mismatch",
  });
  expect(Lead.findOne).not.toHaveBeenCalled();
  expect(Message.findOne).not.toHaveBeenCalled();
});
