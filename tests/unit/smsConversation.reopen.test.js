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

const queryResult = (value) => ({ sort: jest.fn().mockResolvedValue(value) });

test("reopens a stale closed conversation but preserves intentional human takeover", async () => {
  const lead = { _id: "lead-1", phone: "+14045550101", phoneLookup: "+14045550101", status: "contacted" };
  const closed = {
    _id: "conversation-1",
    lead: lead._id,
    status: "closed",
    humanTakeover: false,
    customerPhone: "+14045550101",
  };
  Lead.findOne.mockReturnValue(queryResult(lead));
  Lead.findByIdAndUpdate.mockResolvedValue(lead);
  Conversation.findOne.mockReturnValue(queryResult(closed));
  Conversation.findByIdAndUpdate.mockResolvedValue(closed);
  Conversation.findOneAndUpdate.mockResolvedValue({ ...closed, status: "open" });

  await getOrCreateSmsLeadAndConversation({
    business: { _id: "business-1", estimatedJobValue: 500 },
    customerPhone: "+14045550101",
    body: "leaking faucet",
    source: "sms",
    reopenEligible: true,
  });
  expect(Conversation.findOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ _id: "conversation-1", status: "closed", humanTakeover: { $ne: true }, aiEnabled: { $ne: false } }),
    { $set: expect.objectContaining({ status: "open", reopenReason: "returning_customer_contact" }) },
    expect.objectContaining({ returnDocument: "after" }),
  );
});
