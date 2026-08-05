import { getOwnedBusiness } from "../../src/services/businessScope.service.js";
import { executeManualSmsOperation } from "../../src/services/messaging/manualSmsOperation.service.js";
import { handleConversationManualMessage } from "../../src/services/messaging/manualConversationMessage.service.js";

jest.mock("../../src/services/businessScope.service.js", () => ({
  __esModule: true,
  getOwnedBusiness: jest.fn(),
}));

jest.mock("../../src/services/messaging/manualSmsOperation.service.js", () => ({
  __esModule: true,
  executeManualSmsOperation: jest.fn(),
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

test("a dashboard human reply uses the durable manual SMS operation before reporting success", async () => {
  const business = {
    _id: "64f000000000000000000001",
    phone: "+14045552202",
  };
  const conversationId = "64f000000000000000000010";
  const actorId = "64f000000000000000000002";
  const message = {
    _id: "64f000000000000000000020",
    conversation: conversationId,
    business: business._id,
    body: "A technician will call you shortly.",
    status: "queued",
  };
  const operation = {
    _id: "64f000000000000000000030",
    operationId: "manual-operation-1",
    state: "completed",
    providerMessageId: "SM_MANUAL_1",
  };

  getOwnedBusiness.mockResolvedValue(business);
  executeManualSmsOperation.mockResolvedValue({
    accepted: true,
    completed: true,
    blocked: false,
    pending: false,
    message,
    operation,
    replayed: false,
  });

  const req = {
    user: { userId: actorId },
    body: {
      conversation: conversationId,
      body: message.body,
      to: "+14045558258",
      operationId: operation.operationId,
    },
    params: {},
    get: jest.fn(() => ""),
  };
  const res = response();
  const next = jest.fn();

  await handleConversationManualMessage(req, res, next);

  expect(getOwnedBusiness).toHaveBeenCalledWith({
    user: req.user,
    requestedBusinessId: undefined,
  });
  expect(executeManualSmsOperation).toHaveBeenCalledWith({
    business,
    actorId,
    to: "+14045558258",
    body: message.body,
    conversationId,
    operationId: operation.operationId,
    source: "conversation_dashboard",
  });
  expect(res.status).toHaveBeenCalledWith(201);
  expect(res.json).toHaveBeenCalledWith({
    success: true,
    message: "Manual SMS accepted by Twilio and saved.",
    data: message,
    operation: {
      id: operation._id,
      operationId: operation.operationId,
      state: operation.state,
      replayed: false,
    },
  });
  expect(next).not.toHaveBeenCalled();
});
