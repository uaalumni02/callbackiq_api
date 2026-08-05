import Message from "../../src/models/message.js";
import CallLog from "../../src/models/callLog.js";
import { processTwilioMessageStatus } from "../../src/services/messaging/smsDeliveryStatus.service.js";

jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    countDocuments: jest.fn(),
  },
}));
jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitMessageUpdated: jest.fn(),
    emitCallUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createSystemAlert: jest.fn() },
}));

test("updates Message and CallLog when Twilio reports undelivered", async () => {
  Message.findOneAndUpdate.mockResolvedValue({ _id: "message-1" });
  CallLog.findOneAndUpdate.mockResolvedValue({ _id: "call-1" });
  Message.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

  await processTwilioMessageStatus({
    businessId: "business-1",
    payload: {
      MessageSid: "SM123",
      MessageStatus: "undelivered",
      ErrorCode: "30007",
    },
  });
  expect(Message.findOneAndUpdate).toHaveBeenCalledWith(
    { business: "business-1", providerMessageId: "SM123" },
    expect.objectContaining({
      $set: expect.objectContaining({ status: "undelivered", deliveryErrorCode: "30007" }),
    }),
    { returnDocument: "after" },
  );
  expect(CallLog.findOneAndUpdate).toHaveBeenCalledWith(
    { business: "business-1", smsProviderMessageId: "SM123" },
    expect.objectContaining({
      $set: expect.objectContaining({ missedCallTextDelivered: false }),
    }),
    { returnDocument: "after" },
  );
});
