import { EventEmitter } from "events";

import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";
import missedCallAutomationLifecycle from "../../src/middleware/missed-call-automation-lifecycle.js";

jest.mock("../../src/models/business.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/conversation.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: { schedule: jest.fn() },
}));

const businessQuery = (value) => {
  const query = { select: jest.fn(() => query), lean: jest.fn().mockResolvedValue(value) };
  return query;
};
const conversationQuery = (value) => {
  const query = {
    sort: jest.fn(() => query),
    select: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};
const response = (statusCode = 200) => Object.assign(new EventEmitter(), { statusCode });
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("missedCallAutomationLifecycle", () => {
  let next;
  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    AutomationTriggerService.schedule.mockResolvedValue([]);
  });

  test.each(["completed", "in-progress", "ringing", "answered", ""])(
    "ignores non-missed status %s",
    (CallStatus) => {
      const res = response();
      missedCallAutomationLifecycle({ body: { CallStatus } }, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.listenerCount("finish")).toBe(0);
    },
  );

  test.each(["busy", "failed", "no-answer", "no_answer", "canceled", " BUSY "])(
    "registers lifecycle work for %s",
    (CallStatus) => {
      const res = response();
      missedCallAutomationLifecycle({ body: { CallStatus } }, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.listenerCount("finish")).toBe(1);
    },
  );

  test("does nothing after an unsuccessful controller response", async () => {
    const res = response(500);
    missedCallAutomationLifecycle({ body: { CallStatus: "busy" } }, res, next);
    res.emit("finish");
    await flush();
    expect(Business.findOne).not.toHaveBeenCalled();
  });

  test.each([
    [{ To: "", From: "customer", CallSid: "CA1" }],
    [{ To: "business", From: "", CallSid: "CA1" }],
    [{ To: "business", From: "customer", CallSid: "" }],
  ])("requires all Twilio identifiers", async (body) => {
    const res = response();
    missedCallAutomationLifecycle({ body: { ...body, CallStatus: "busy" } }, res, next);
    res.emit("finish");
    await flush();
    expect(Business.findOne).not.toHaveBeenCalled();
  });

  test("uses ParentCallSid and stops when automation is disabled", async () => {
    Business.findOne.mockReturnValue(businessQuery({ _id: "b1", features: { automatedFollowUpEnabled: false } }));
    const res = response();
    missedCallAutomationLifecycle(
      { body: { To: "business", From: "customer", ParentCallSid: "CA-parent", CallStatus: "busy" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(Conversation.findOne).not.toHaveBeenCalled();
  });

  test("stops when no conversation is found", async () => {
    Business.findOne.mockReturnValue(businessQuery({ _id: "b1", features: { automatedFollowUpEnabled: true } }));
    Conversation.findOne.mockReturnValue(conversationQuery(null));
    const res = response();
    missedCallAutomationLifecycle(
      { body: { To: "business", From: "customer", CallSid: "CA1", CallStatus: "busy" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(AutomationTriggerService.schedule).not.toHaveBeenCalled();
  });

  test("schedules a durable missed-call workflow", async () => {
    Business.findOne.mockReturnValue(businessQuery({ _id: "b1", features: { automatedFollowUpEnabled: true } }));
    Conversation.findOne.mockReturnValue(conversationQuery({ _id: "c1", lead: "l1" }));
    const res = response();
    missedCallAutomationLifecycle(
      { body: { To: "business", From: "customer", CallSid: "CA1", CallStatus: "busy" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(AutomationTriggerService.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "b1",
        trigger: "missed_call_no_response",
        leadId: "l1",
        conversationId: "c1",
        triggerInstanceId: "CA1",
      }),
    );
  });

  test("logs deferred scheduling failures", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    Business.findOne.mockImplementation(() => {
      throw new Error("database down");
    });
    const res = response();
    missedCallAutomationLifecycle(
      { body: { To: "business", From: "customer", CallSid: "CA1", CallStatus: "busy" } },
      res,
      next,
    );
    res.emit("finish");
    await flush();
    expect(consoleError).toHaveBeenCalledWith("Missed-call automation lifecycle failed:", expect.any(Error));
    consoleError.mockRestore();
  });
});
