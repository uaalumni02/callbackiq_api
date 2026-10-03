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

describe("Twilio SMS delivery transitions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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
      {
        business: "business-1",
        providerMessageId: "SM123",
        status: { $in: ["queued", "sent", "undelivered"] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "undelivered", deliveryErrorCode: "30007" }),
        $push: expect.objectContaining({ deliveryEvents: expect.any(Object) }),
      }),
      { returnDocument: "after" },
    );
    expect(CallLog.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        business: "business-1",
        smsProviderMessageId: "SM123",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ missedCallTextDelivered: false }),
        $push: expect.objectContaining({ smsDeliveryEvents: expect.any(Object) }),
      }),
      { returnDocument: "after" },
    );
  });

  test("records but does not apply a late status that would regress delivery", async () => {
    Message.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "message-1", status: "delivered" });
    CallLog.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "call-1", smsDeliveryStatus: "delivered" });

    await processTwilioMessageStatus({
      businessId: "business-1",
      payload: { MessageSid: "SM123", MessageStatus: "sent" },
    });

    expect(Message.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { business: "business-1", providerMessageId: "SM123" },
      expect.objectContaining({
        $push: expect.objectContaining({ deliveryEvents: expect.any(Object) }),
      }),
      { returnDocument: "after" },
    );
    const conflictEvent = Message.findOneAndUpdate.mock.calls[1][1].$push.deliveryEvents.$each[0];
    expect(conflictEvent).toMatchObject({ applied: false, conflict: true });
  });
});

test('manual appointment without a conversation tracks provider delivery on its notice', async () => {
 const Notice = (await import('../../src/models/appointmentNotificationJob.js')).default;
 const update = jest.spyOn(Notice, 'findOneAndUpdate').mockResolvedValue({ _id: 'notice', deliveryStatus: 'delivered' });
 Message.findOneAndUpdate.mockResolvedValue(null);CallLog.findOneAndUpdate.mockResolvedValue(null);
 try {
  const result = await processTwilioMessageStatus({ businessId: '64b000000000000000000001', payload: { MessageSid: 'SMmanual', MessageStatus: 'delivered' }, skipReconciliationPersistence: true });
  expect(result.appointmentNotice.deliveryStatus).toBe('delivered');
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ business: '64b000000000000000000001', providerMessageId: 'SMmanual' }), expect.objectContaining({ $set: expect.objectContaining({ deliveryStatus: 'delivered' }) }), expect.anything());
 } finally { update.mockRestore(); }
});
