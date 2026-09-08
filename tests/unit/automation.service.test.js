import Alert from "../../src/models/alert.js";
import Appointment from "../../src/models/appointment.js";
import AutomationJob from "../../src/models/automationJob.js";
import Business from "../../src/models/business.js";
import ContactPreference from "../../src/models/contactPreference.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import SocketService from "../../src/services/socket.service.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import AutomationService from "../../src/services/automation/automation.service.js";

jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
  resetTwilioClient: jest.fn(),
}));
jest.mock("../../src/models/alert.js", () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));
jest.mock("../../src/models/appointment.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/automationJob.js", () => ({ __esModule: true, default: { findById: jest.fn(), updateMany: jest.fn() } }));
jest.mock("../../src/models/business.js", () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock("../../src/models/contactPreference.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/conversation.js", () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock("../../src/models/lead.js", () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock("../../src/models/message.js", () => ({ __esModule: true, default: { countDocuments: jest.fn(), create: jest.fn() } }));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitMessageCreated: jest.fn(), emitAlertCreated: jest.fn() },
}));

const leanQuery = (value) => {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};

const populatedQuery = (value) => {
  const query = {
    populate: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
};

const doc = (overrides = {}) => ({
  _id: "job-1",
  status: "processing",
  action: "send_sms",
  template: "Hello {{lead.customerName}} from {{business.businessName}} {{missing.value}}",
  attemptNumber: 1,
  workflow: {
    allowedDays: [0, 1, 2, 3, 4, 5, 6],
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    maximumAttempts: 3,
    minimumIntervalMinutes: 120,
  },
  business: {
    _id: "b1",
    businessName: "CallBackIQ Plumbing",
    phone: "+14045550101",
    timezone: "UTC",
    toObject: () => ({ businessName: "CallBackIQ Plumbing", phone: "+14045550101" }),
  },
  conversation: {
    _id: "c1",
    customerPhone: "+14045550100",
    toObject: () => ({ customerPhone: "+14045550100" }),
  },
  lead: {
    _id: "l1",
    customerName: "Jane",
    toObject: () => ({ customerName: "Jane" }),
  },
  appointment: null,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("AutomationService", () => {
  const originalEnv = {
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "token";
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    sendSms.mockResolvedValue({
      sid: "SM1",
      status: "queued",
      suppressed: false,
    });
    AutomationService.resetTwilioClient();

    Business.findById.mockReturnValue(leanQuery({
      _id: "b1",
      isActive: true,
      features: { automatedFollowUpEnabled: true },
    }));
    Conversation.findById.mockReturnValue(leanQuery({
      _id: "c1",
      status: "open",
      humanTakeover: false,
      customerPhone: "+14045550100",
    }));
    Lead.findById.mockReturnValue(leanQuery({ _id: "l1", status: "new" }));
    ContactPreference.findOne.mockReturnValue(leanQuery(null));
    Appointment.findOne.mockReturnValue(leanQuery(null));
    Alert.findOne.mockReturnValue(leanQuery(null));
    Message.countDocuments.mockResolvedValue(0);
    Message.create.mockResolvedValue({ _id: "message-1" });
    Alert.create.mockResolvedValue({ _id: "alert-1" });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test.each([
    ["business_inactive", { business: { isActive: false } }],
    ["automation_disabled", { business: { isActive: true, features: { automatedFollowUpEnabled: false } } }],
    ["conversation_not_open", { conversation: null }],
    ["conversation_not_open", { conversation: { status: "closed" } }],
    ["human_takeover", { conversation: { status: "open", humanTakeover: true } }],
    ["intake_awaiting_team", { conversation: { status: "open", orchestration: { handoffReason: "intake_complete" } } }],
    ["lead_booked", { lead: { status: "booked" } }],
    ["lead_lost", { lead: { status: "lost" } }],
    ["lead_spam", { lead: { status: "spam" } }],
    ["customer_opted_out", { preference: { smsStatus: "opted_out" } }],
    ["appointment_confirmed", { appointment: { status: "confirmed" } }],
    ["safety_condition", { alert: { type: "safety_emergency" } }],
  ])("returns suppression reason %s", async (expected, setup) => {
    if (setup.business !== undefined) Business.findById.mockReturnValue(leanQuery(setup.business));
    if (setup.conversation !== undefined) Conversation.findById.mockReturnValue(leanQuery(setup.conversation));
    if (setup.lead !== undefined) Lead.findById.mockReturnValue(leanQuery(setup.lead));
    if (setup.preference !== undefined) ContactPreference.findOne.mockReturnValue(leanQuery(setup.preference));
    if (setup.appointment !== undefined) Appointment.findOne.mockReturnValue(leanQuery(setup.appointment));
    if (setup.alert !== undefined) Alert.findOne.mockReturnValue(leanQuery(setup.alert));

    await expect(
      AutomationService.suppressionReason({ business: "b1", conversation: "c1", lead: "l1", appointment: "a1" }),
    ).resolves.toBe(expected);
  });

  test("handles jobs without optional entity references", async () => {
    await expect(AutomationService.suppressionReason({ business: "b1" })).resolves.toBe("conversation_not_open");
    expect(Lead.findById).not.toHaveBeenCalled();
    expect(Appointment.findOne).not.toHaveBeenCalled();
  });

  test("suppresses repeated delivery failures and otherwise allows execution", async () => {
    Message.countDocuments.mockResolvedValueOnce(2);
    await expect(
      AutomationService.suppressionReason({ business: "b1", conversation: "c1", lead: "l1" }),
    ).resolves.toBe("repeated_delivery_failure");

    Message.countDocuments.mockResolvedValueOnce(1);
    await expect(
      AutomationService.suppressionReason({ business: { _id: "b1" }, conversation: { _id: "c1" }, lead: { _id: "l1" } }),
    ).resolves.toBeNull();
  });

  test("loads contact preference only when a customer phone exists", async () => {
    Conversation.findById.mockReturnValue(leanQuery({ status: "open", humanTakeover: false, customerPhone: "" }));
    await AutomationService.suppressionReason({ business: "b1", conversation: "c1" });
    expect(ContactPreference.findOne).not.toHaveBeenCalled();
  });

  test("returns null for missing or non-processing jobs", async () => {
    AutomationJob.findById.mockReturnValueOnce(populatedQuery(null));
    await expect(AutomationService.execute({ _id: "missing" })).resolves.toBeNull();
    AutomationJob.findById.mockReturnValueOnce(populatedQuery(doc({ status: "scheduled" })));
    await expect(AutomationService.execute({ _id: "scheduled" })).resolves.toBeNull();
  });

  test("cancels a suppressed processing job", async () => {
    const populated = doc();
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue("customer_opted_out");
    await expect(AutomationService.execute({ _id: "job-1" })).resolves.toBe(populated);
    expect(populated).toMatchObject({
      status: "canceled",
      failureReason: "customer_opted_out",
      lockedAt: null,
      lockedBy: null,
    });
    expect(populated.canceledAt).toBeInstanceOf(Date);
    expect(populated.save).toHaveBeenCalled();
  });

  test("reschedules on a disallowed day", async () => {
    const populated = doc({ workflow: { allowedDays: [], quietHoursStart: "22:00", quietHoursEnd: "07:00" } });
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await AutomationService.execute({ _id: "job-1" });
    expect(populated.status).toBe("scheduled");
    expect(populated.executeAt).toEqual(new Date("2026-07-27T13:00:00.000Z"));
  });

  test("reschedules during normal and overnight quiet hours", async () => {
    const normal = doc({ workflow: { allowedDays: [1], quietHoursStart: "11:00", quietHoursEnd: "13:00" } });
    AutomationJob.findById.mockReturnValueOnce(populatedQuery(normal));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await AutomationService.execute({ _id: "job-1" });
    expect(normal.status).toBe("scheduled");

    jest.setSystemTime(new Date("2026-07-27T23:30:00.000Z"));
    const overnight = doc({ workflow: { allowedDays: [1], quietHoursStart: "22:00", quietHoursEnd: "07:00" } });
    AutomationJob.findById.mockReturnValueOnce(populatedQuery(overnight));
    await AutomationService.execute({ _id: "job-2" });
    expect(overnight.status).toBe("scheduled");
  });

  test("does not treat equal quiet-hour boundaries as quiet", async () => {
    const populated = doc({ workflow: { allowedDays: [1], quietHoursStart: "12:00", quietHoursEnd: "12:00", maximumAttempts: 3 } });
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await AutomationService.execute({ _id: "job-1" });
    expect(populated.status).toBe("completed");
  });

  test("sends an interpolated SMS with the business phone", async () => {
    const populated = doc();
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await expect(AutomationService.execute({ _id: "job-1" })).resolves.toBe(populated);
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        business: populated.business,
        businessId: "b1",
        to: "+14045550100",
        from: "+14045550101",
        body: "Hello Jane from CallBackIQ Plumbing",
        actorType: "automation",
        source: "automation_workflow",
        usageCategory: "automation",
        conversationId: "c1",
        leadId: "l1",
      }),
    );
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({
      body: "Hello Jane from CallBackIQ Plumbing",
      providerMessageId: "SM1",
      status: "queued",
    }));
    expect(SocketService.emitMessageCreated).toHaveBeenCalledWith("b1", { _id: "message-1" });
    expect(populated).toMatchObject({ status: "completed", failureReason: "", lockedAt: null, lockedBy: null });
  });

  test("uses Messaging Service and default queued status", async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG123";
    sendSms.mockResolvedValueOnce({
      sid: "SM2",
      status: "queued",
      suppressed: false,
    });
    const populated = doc({ lead: null });
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await AutomationService.execute({ _id: "job-1" });
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        messagingServiceSid: "MG123",
        from: "+14045550101",
      }),
    );
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({ lead: null, status: "queued" }));
  });

  test.each(["create_alert", "mark_for_review"])("creates staff review alerts for %s", async (action) => {
    const populated = doc({ action, template: "Review {{lead.customerName}}", appointment: { _id: "a1", toObject: () => ({}) } });
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await AutomationService.execute({ _id: "job-1" });
    expect(Alert.create).toHaveBeenCalledWith(expect.objectContaining({
      appointment: "a1",
      type: "unanswered_hot_lead",
      message: "Review Jane",
      priority: "medium",
    }));
    expect(SocketService.emitAlertCreated).toHaveBeenCalledWith("b1", { _id: "alert-1" });
  });

  test("uses fallback alert text for an empty template and completes unknown actions", async () => {
    const review = doc({ action: "create_alert", template: "" });
    AutomationJob.findById.mockReturnValueOnce(populatedQuery(review));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await AutomationService.execute({ _id: "review" });
    expect(Alert.create).toHaveBeenCalledWith(expect.objectContaining({ message: "This follow-up requires staff review." }));

    const unknown = doc({ action: "unknown", template: "ignored" });
    AutomationJob.findById.mockReturnValueOnce(populatedQuery(unknown));
    await AutomationService.execute({ _id: "unknown" });
    expect(unknown.status).toBe("completed");
  });

  test("retries failed actions below the maximum attempt count", async () => {
    const populated = doc({ template: "", attemptNumber: 1 });
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    await expect(AutomationService.execute({ _id: "job-1" })).rejects.toThrow("empty message");
    expect(populated).toMatchObject({ status: "scheduled", attemptNumber: 2, failureReason: expect.stringContaining("empty message") });
    expect(populated.executeAt).toEqual(new Date("2026-07-27T14:00:00.000Z"));
  });

  test("marks failed actions after the maximum attempt", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    sendSms.mockRejectedValueOnce(
      new Error(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for automation SMS.",
      ),
    );
    const populated = doc({ attemptNumber: 3, workflow: { allowedDays: [1], quietHoursStart: "22:00", quietHoursEnd: "07:00", maximumAttempts: 3 } });
    AutomationJob.findById.mockReturnValue(populatedQuery(populated));
    jest.spyOn(AutomationService, "suppressionReason").mockResolvedValue(null);
    AutomationService.resetTwilioClient();
    await expect(AutomationService.execute({ _id: "job-1" })).rejects.toThrow("TWILIO_ACCOUNT_SID");
    expect(populated.status).toBe("failed");
  });

  test("cancels obsolete jobs with optional filters", async () => {
    AutomationJob.updateMany.mockResolvedValue({ modifiedCount: 2 });
    await expect(
      AutomationService.cancelObsolete({ businessId: "b1", leadId: "l1", conversationId: "c1", reason: "customer_replied" }),
    ).resolves.toEqual({ modifiedCount: 2 });
    expect(AutomationJob.updateMany).toHaveBeenCalledWith(
      { business: "b1", status: { $in: ["scheduled", "processing"] }, lead: "l1", conversation: "c1" },
      { $set: expect.objectContaining({ status: "canceled", failureReason: "customer_replied" }) },
    );

    await AutomationService.cancelObsolete({ businessId: "b1", reason: "disabled" });
    expect(AutomationJob.updateMany).toHaveBeenLastCalledWith(
      { business: "b1", status: { $in: ["scheduled", "processing"] } },
      expect.any(Object),
    );
  });
});
