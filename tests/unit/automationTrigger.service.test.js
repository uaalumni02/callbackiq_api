import AutomationJob from "../../src/models/automationJob.js";
import AutomationWorkflow from "../../src/models/automationWorkflow.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";

jest.mock("../../src/models/automationJob.js", () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock("../../src/models/automationWorkflow.js", () => ({ __esModule: true, default: { find: jest.fn() } }));

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe("AutomationTriggerService", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rejects invalid occurrence dates", async () => {
    await expect(
      AutomationTriggerService.schedule({ businessId: "b1", trigger: "test", occurredAt: "bad" }),
    ).rejects.toMatchObject({ statusCode: 400, message: "occurredAt must be a valid date." });
  });

  test("loads only enabled approved workflows", async () => {
    AutomationWorkflow.find.mockReturnValue(leanResult([]));
    await expect(
      AutomationTriggerService.schedule({
        businessId: "b1",
        trigger: "missed_call_no_response",
        triggerInstanceId: "call-1",
      }),
    ).resolves.toEqual([]);
    expect(AutomationWorkflow.find).toHaveBeenCalledWith({
      business: "b1",
      trigger: "missed_call_no_response",
      enabled: true,
      $or: [{ templateApprovalRequired: false }, { templatesApproved: true }],
    });
  });

  test("creates cumulative delayed jobs and respects maximum attempts", async () => {
    const occurredAt = new Date("2026-07-27T12:00:00.000Z");
    AutomationWorkflow.find.mockReturnValue(
      leanResult([
        {
          _id: "workflow-1",
          maximumAttempts: 2,
          steps: [
            { delayMinutes: 5, action: "send_sms", template: "First" },
            { delayMinutes: 10, action: "send_sms", template: "Second" },
            { delayMinutes: 20, action: "send_sms", template: "Ignored" },
          ],
        },
      ]),
    );
    AutomationJob.create
      .mockResolvedValueOnce({ _id: "job-1" })
      .mockResolvedValueOnce({ _id: "job-2" });

    const jobs = await AutomationTriggerService.schedule({
      businessId: "b1",
      trigger: "missed_call_no_response",
      leadId: "l1",
      conversationId: "c1",
      appointmentId: "a1",
      triggerInstanceId: "call-1",
      occurredAt,
    });
    expect(jobs).toHaveLength(2);
    expect(AutomationJob.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        executeAt: new Date("2026-07-27T12:05:00.000Z"),
        idempotencyKey: "missed_call_no_response:call-1:workflow-1:0",
      }),
    );
    expect(AutomationJob.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        executeAt: new Date("2026-07-27T12:15:00.000Z"),
        idempotencyKey: "missed_call_no_response:call-1:workflow-1:1",
      }),
    );
  });

  test("uses entity fallback keys and workflow length defaults", async () => {
    AutomationWorkflow.find.mockReturnValue(
      leanResult([{ _id: "w1", steps: [{ action: "create_alert", template: "Review" }] }]),
    );
    AutomationJob.create.mockResolvedValue({ _id: "job" });
    await AutomationTriggerService.schedule({
      businessId: "b1",
      trigger: "test",
      conversationId: "c1",
      occurredAt: "2026-07-27T12:00:00Z",
    });
    expect(AutomationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "test:c1:w1:0", executeAt: new Date("2026-07-27T12:00:00Z") }),
    );
  });

  test("ignores duplicate jobs but rethrows nonduplicate errors", async () => {
    AutomationWorkflow.find.mockReturnValue(
      leanResult([{ _id: "w1", maximumAttempts: 2, steps: [{}, {}] }]),
    );
    AutomationJob.create.mockRejectedValueOnce({ code: 11000 }).mockResolvedValueOnce({ _id: "job-2" });
    await expect(
      AutomationTriggerService.schedule({ businessId: "b1", trigger: "test", leadId: "l1" }),
    ).resolves.toEqual([{ _id: "job-2" }]);

    AutomationJob.create.mockRejectedValueOnce(new Error("database failure"));
    await expect(
      AutomationTriggerService.schedule({ businessId: "b1", trigger: "test", leadId: "l1" }),
    ).rejects.toThrow("database failure");
  });
});
