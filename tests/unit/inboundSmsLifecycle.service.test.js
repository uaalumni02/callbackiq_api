import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";
import AutomationService from "../../src/services/automation/automation.service.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";
import { classifyInboundSmsCommand } from "../../src/services/messaging/contactPreference.service.js";
import {
  runInboundSmsLifecycleAfterClaim,
} from "../../src/services/messaging/inboundSmsLifecycle.service.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
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

jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({
  classifyInboundSmsCommand: jest.fn(),
}));

jest.mock("../../src/helpers/ai/aiGuardrails.js", () => ({
  evaluateDeterministicInboundGuardrails: jest.fn(() => ({
    handled: false,
  })),
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalError: jest.fn(),
}));

const selectable = (result) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(result),
  }),
});

const base = () => ({
  business: { _id: "b1" },
  conversation: { _id: "c1", lead: "l1" },
  lead: { _id: "l1" },
  inboundMessage: {
    _id: "m1",
    providerMessageId: "SM-IN",
    body: "I need a plumber",
    metadata: {},
  },
});

describe("runInboundSmsLifecycleAfterClaim", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AutomationService.cancelObsolete.mockResolvedValue({});
    ConversionEventService.record.mockResolvedValue({});
    AutomationTriggerService.schedule.mockResolvedValue({});
    classifyInboundSmsCommand.mockReturnValue({ handled: false });
  });

  test("records customer reply lifecycle using the provider MessageSid as idempotency key", async () => {
    Business.findById.mockReturnValue(
      selectable({ features: { automatedFollowUpEnabled: false } }),
    );
    Conversation.findById.mockReturnValue(
      selectable({ status: "open", humanTakeover: false }),
    );
    Lead.findById.mockReturnValue(
      selectable({ status: "new" }),
    );

    await runInboundSmsLifecycleAfterClaim(base());

    expect(AutomationService.cancelObsolete).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "customer_replied" }),
    );
    expect(ConversionEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "customer_replied:SM-IN",
      }),
    );
  });

  test("schedules incomplete qualification only after durable ingress", async () => {
    Business.findById.mockReturnValue(
      selectable({ features: { automatedFollowUpEnabled: true } }),
    );
    Conversation.findById.mockReturnValue(
      selectable({
        status: "open",
        humanTakeover: false,
        bookingState: { status: "idle" },
      }),
    );
    Lead.findById.mockReturnValue(
      selectable({
        status: "new",
        serviceNeeded: "Plumbing",
        address: "",
        preferredAppointmentTime: "",
      }),
    );

    await runInboundSmsLifecycleAfterClaim(base());

    expect(AutomationTriggerService.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "incomplete_qualification",
        triggerInstanceId: "SM-IN",
      }),
    );
  });
});
