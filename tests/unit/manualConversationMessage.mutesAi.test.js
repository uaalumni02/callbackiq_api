import Db from "../../src/db/db.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import { evaluateManualSmsPolicy } from "../../src/services/messaging/manualSmsPolicy.service.js";
import { handleConversationManualMessage } from "../../src/services/messaging/manualConversationMessage.service.js";

jest.mock("../../src/db/db.js", () => ({
  __esModule: true,
  default: { getBusinessScopeByOwner: jest.fn() },
}));
jest.mock("../../src/models/business.js", () => ({ __esModule: true, default: {} }));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));
jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));
jest.mock("../../src/services/messaging/manualSmsPolicy.service.js", () => ({
  __esModule: true,
  evaluateManualSmsPolicy: jest.fn(),
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitConversationUpdated: jest.fn(),
    emitMessageCreated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
}));

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("a dashboard human reply permanently pauses AI before sending", async () => {
  const business = { _id: "business-1", phone: "+14045552202" };
  const conversation = {
    _id: "conversation-1",
    business: business._id,
    lead: "lead-1",
    customerPhone: "+14045558258",
  };
  const muted = { ...conversation, aiEnabled: false, humanTakeover: true };
  Db.getBusinessScopeByOwner.mockResolvedValue(business);
  Conversation.findOne.mockResolvedValue(conversation);
  evaluateManualSmsPolicy.mockResolvedValue({
    allowed: true,
    normalizedTo: conversation.customerPhone,
    body: "A technician will call you shortly.",
    directResponse: true,
  });
  Conversation.findByIdAndUpdate
    .mockResolvedValueOnce(muted)
    .mockResolvedValueOnce({ ...muted, lastMessage: "A technician will call you shortly." });
  sendSms.mockResolvedValue({
    sid: "SM_MANUAL_1",
    status: "queued",
    body: "A technician will call you shortly.",
    segmentCount: 1,
  });
  Message.create.mockResolvedValue({ _id: "message-1" });
  const req = {
    user: { userId: "owner-1" },
    body: { conversation: conversation._id, body: "A technician will call you shortly." },
  };
  const res = response();

  await handleConversationManualMessage(req, res);

  expect(Conversation.findByIdAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
    sendSms.mock.invocationCallOrder[0],
  );
  expect(Conversation.findByIdAndUpdate).toHaveBeenNthCalledWith(
    1,
    conversation._id,
    expect.objectContaining({
      aiEnabled: false,
      humanTakeover: true,
      humanTakeoverBy: "owner-1",
    }),
    expect.objectContaining({ returnDocument: "after" }),
  );
  expect(res.status).toHaveBeenCalledWith(201);
});
