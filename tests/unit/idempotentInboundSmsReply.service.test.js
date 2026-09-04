import Message from "../../src/models/message.js";
import Conversation from "../../src/models/conversation.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import AlertService from "../../src/services/alert.service.js";
import SocketService from "../../src/services/socket.service.js";
import {
  sendIdempotentInboundSmsReply,
} from "../../src/services/messaging/idempotentInboundSmsReply.service.js";

jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: {
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/services/twilioSmsService.js", () => ({
  sendSms: jest.fn(),
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: jest.fn(),
  },
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitMessageCreated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

const context = () => ({
  business: { _id: "b1", phone: "+14705550001" },
  lead: { _id: "l1" },
  conversation: {
    _id: "c1",
    lead: "l1",
    customerPhone: "+14705550002",
    replyFromPhone: "+14705550001",
  },
  inboundMessage: { _id: "m-in" },
  body: "We received your message.",
  metadata: { source: "test_reply" },
});

describe("sendIdempotentInboundSmsReply", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("reuses a durable provider result and never sends twice", async () => {
    Message.findOne.mockResolvedValue({
      _id: "m-out",
      providerMessageId: "SM123",
      status: "sent",
      deliveryUncertain: false,
    });

    const result = await sendIdempotentInboundSmsReply(context());

    expect(result).toMatchObject({ sent: true, duplicate: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  test("claims the outbound record and sends with a deterministic idempotency key", async () => {
    const queued = {
      _id: "m-out",
      metadata: { source: "test_reply" },
    };
    Message.findOne.mockResolvedValue(null);
    Message.create.mockResolvedValue(queued);
    Message.findOneAndUpdate.mockResolvedValue({
      ...queued,
      deliveryAttemptedAt: new Date(),
    });
    sendSms.mockResolvedValue({
      sid: "SM456",
      status: "queued",
      body: "We received your message.",
      segmentCount: 1,
    });
    Message.findByIdAndUpdate.mockResolvedValue({
      ...queued,
      providerMessageId: "SM456",
      status: "queued",
    });
    Conversation.findByIdAndUpdate.mockResolvedValue({ _id: "c1" });

    const result = await sendIdempotentInboundSmsReply(context());

    expect(Message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyToMessage: "m-in",
        metadata: expect.objectContaining({
          idempotencyKey: "sms-inbound-reply:b1:m-in",
        }),
      }),
    );
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          idempotencyKey: "sms-inbound-reply:b1:m-in",
        }),
      }),
    );
    expect(result.sent).toBe(true);
    expect(SocketService.emitMessageCreated).toHaveBeenCalled();
  });

  test("blocks automatic resend after an uncertain prior provider attempt", async () => {
    Message.findOne.mockResolvedValue({
      _id: "m-out",
      providerMessageId: "",
      status: "queued",
      deliveryAttemptedAt: new Date(),
    });
    Message.findByIdAndUpdate.mockResolvedValue({
      _id: "m-out",
      providerMessageId: "",
      status: "failed",
      deliveryUncertain: true,
    });
    AlertService.createSystemAlert.mockResolvedValue({ _id: "a1" });

    const result = await sendIdempotentInboundSmsReply(context());

    expect(result).toMatchObject({
      sent: false,
      deliveryUncertain: true,
      reason: "delivery_uncertain",
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "sms_delivery_uncertain:m-out",
      }),
    );
  });
});
