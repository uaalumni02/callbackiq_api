import { EventEmitter } from "events";

import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import { evaluateDeterministicInboundGuardrails } from "../../src/helpers/ai/aiGuardrails.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";
import AutomationService from "../../src/services/automation/automation.service.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";
import inboundSmsLifecycle from "../../src/middleware/inbound-sms-lifecycle.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findById: jest.fn() },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findById: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));
jest.mock("../../src/helpers/ai/aiGuardrails.js", () => ({
  __esModule: true,
  evaluateDeterministicInboundGuardrails: jest.fn(),
}));
jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: { record: jest.fn() },
}));
jest.mock("../../src/services/automation/automation.service.js", () => ({
  __esModule: true,
  default: { cancelObsolete: jest.fn() },
}));
jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: { schedule: jest.fn() },
}));

const selectLean = (value) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }),
});
const conversationFind = (value) => {
  const query = {
    sort: jest.fn(() => query),
    select: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};
const response = (statusCode = 200) => Object.assign(new EventEmitter(), { statusCode });
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("inboundSmsLifecycle", () => {
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: false });
    AutomationService.cancelObsolete.mockResolvedValue({ modifiedCount: 1 });
    ConversionEventService.record.mockResolvedValue({ _id: "event" });
    AutomationTriggerService.schedule.mockResolvedValue([]);
  });

  test.each([
    [{ From: "+14045550100" }],
    [{ To: "+14045550101" }],
    [{}],
  ])("passes through incomplete Twilio payloads", async (body) => {
    await inboundSmsLifecycle({ body }, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(Business.findOne).not.toHaveBeenCalled();
  });

  test("passes through when the business is unknown", async () => {
    Business.findOne.mockReturnValue(selectLean(null));
    await inboundSmsLifecycle(
      { body: { To: "+14045550101", From: "+14045550100" } },
      response(),
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(Conversation.findOne).not.toHaveBeenCalled();
  });

  test("passes through when no active conversation is found", async () => {
    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind(null));
    await inboundSmsLifecycle(
      { body: { To: "+14045550101", From: "+14045550100" } },
      response(),
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(AutomationService.cancelObsolete).not.toHaveBeenCalled();
  });

  test("suppresses obsolete jobs and records a deduplicated customer reply", async () => {
    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: "l1" }));
    const res = response();
    await inboundSmsLifecycle(
      {
        body: {
          To: "+14045550101",
          From: "+14045550100",
          MessageSid: "SM123",
          Body: "STOP",
        },
      },
      res,
      next,
    );
    expect(AutomationService.cancelObsolete).toHaveBeenCalledWith({
      businessId: "b1",
      leadId: "l1",
      conversationId: "c1",
      reason: "customer_replied",
    });
    expect(ConversionEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "customer_replied:SM123" }),
    );
    expect(res.listenerCount("finish")).toBe(0);
  });

  test.each(["STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "HELP", "INFO"])(
    "does not schedule qualification follow-up for %s",
    async (command) => {
      Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
      Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: "l1" }));
      const res = response();
      await inboundSmsLifecycle(
        { body: { To: "business", From: "customer", Body: command, SmsSid: "SM2" } },
        res,
        next,
      );
      expect(res.listenerCount("finish")).toBe(0);
    },
  );

  test("does not schedule when deterministic safety or fixed handling applies", async () => {
    evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true });
    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: "l1" }));
    const res = response();
    await inboundSmsLifecycle(
      { body: { To: "business", From: "customer", Body: "I smell gas" } },
      res,
      next,
    );
    expect(res.listenerCount("finish")).toBe(0);
  });

  test("schedules incomplete qualification after a successful response", async () => {
    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: "l1" }));
    Business.findById.mockReturnValue(selectLean({ features: { automatedFollowUpEnabled: true } }));
    Conversation.findById.mockReturnValue(selectLean({ status: "open", humanTakeover: false, bookingState: { status: "collecting_location" } }));
    Lead.findById.mockReturnValue(selectLean({ status: "new", serviceNeeded: "Repair", address: "", preferredAppointmentTime: "Monday" }));
    const res = response(200);
    await inboundSmsLifecycle(
      { body: { To: "business", From: "customer", Body: "Monday", MessageSid: "SM123" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(AutomationTriggerService.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "b1",
        trigger: "incomplete_qualification",
        leadId: "l1",
        conversationId: "c1",
        triggerInstanceId: "SM123",
      }),
    );
  });

  test("uses a fallback trigger key when the provider ID is missing", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1234);
    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: null }));
    Business.findById.mockReturnValue(selectLean({ features: { automatedFollowUpEnabled: true } }));
    Conversation.findById.mockReturnValue(selectLean({ status: "open", humanTakeover: false, bookingState: {} }));
    const res = response(200);
    await inboundSmsLifecycle(
      { body: { To: "business", From: "customer", Body: "hello" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(Lead.findById).not.toHaveBeenCalled();
    expect(AutomationTriggerService.schedule).not.toHaveBeenCalled();
  });

  test.each([
    [500, { features: { automatedFollowUpEnabled: true } }, { status: "open" }, { status: "new" }],
    [200, { features: { automatedFollowUpEnabled: false } }, { status: "open" }, { status: "new" }],
    [200, { features: { automatedFollowUpEnabled: true } }, null, { status: "new" }],
    [200, { features: { automatedFollowUpEnabled: true } }, { status: "closed" }, { status: "new" }],
    [200, { features: { automatedFollowUpEnabled: true } }, { status: "open", humanTakeover: true }, { status: "new" }],
    [200, { features: { automatedFollowUpEnabled: true } }, { status: "open" }, null],
    [200, { features: { automatedFollowUpEnabled: true } }, { status: "open" }, { status: "booked" }],
    [200, { features: { automatedFollowUpEnabled: true } }, { status: "open", bookingState: { status: "offering_slots" } }, { status: "new" }],
    [200, { features: { automatedFollowUpEnabled: true } }, { status: "open", bookingState: {} }, { status: "new", serviceNeeded: "Repair", address: "123 Main", preferredAppointmentTime: "Monday" }],
  ])("suppresses post-response scheduling for ineligible state %#", async (statusCode, updatedBusiness, updatedConversation, updatedLead) => {
    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: "l1" }));
    Business.findById.mockReturnValue(selectLean(updatedBusiness));
    Conversation.findById.mockReturnValue(selectLean(updatedConversation));
    Lead.findById.mockReturnValue(selectLean(updatedLead));
    const res = response(statusCode);
    await inboundSmsLifecycle(
      { body: { To: "business", From: "customer", Body: "hello" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(AutomationTriggerService.schedule).not.toHaveBeenCalled();
  });

  test("catches middleware and deferred callback failures without blocking Twilio", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    Business.findOne.mockImplementationOnce(() => {
      throw new Error("database down");
    });
    await inboundSmsLifecycle(
      { body: { To: "business", From: "customer" } },
      response(),
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("Inbound SMS lifecycle middleware failed:", expect.any(Error));

    Business.findOne.mockReturnValue(selectLean({ _id: "b1" }));
    Conversation.findOne.mockReturnValue(conversationFind({ _id: "c1", lead: "l1" }));
    Business.findById.mockImplementation(() => {
      throw new Error("deferred failure");
    });
    const res = response();
    await inboundSmsLifecycle(
      { body: { To: "business", From: "customer", Body: "hello" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(consoleError).toHaveBeenCalledWith(
      "Incomplete-qualification automation lifecycle failed:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
