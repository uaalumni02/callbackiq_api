import { evaluateDeterministicInboundGuardrails } from "../../src/helpers/ai/aiGuardrails.js";
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

describe('follow-up eligibility read budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    classifyInboundSmsCommand.mockReturnValue({ handled: false });
    AutomationService.cancelObsolete.mockResolvedValue({});
    ConversionEventService.record.mockResolvedValue({});
  });
  test('disabled follow-up still records the reply but avoids conversation and lead reads', async () => {
    Business.findById.mockReturnValue(selectable({features:{automatedFollowUpEnabled:false}}));
    await runInboundSmsLifecycleAfterClaim(base());
    expect(AutomationService.cancelObsolete).toHaveBeenCalledTimes(1);
    expect(ConversionEventService.record).toHaveBeenCalledTimes(1);
    expect(Conversation.findById).not.toHaveBeenCalled();
    expect(Lead.findById).not.toHaveBeenCalled();
    expect(AutomationTriggerService.schedule).not.toHaveBeenCalled();
  });
  test('fresh staff ownership overrides a stale unowned request snapshot', async () => {
    Business.findById.mockReturnValue(selectable({features:{automatedFollowUpEnabled:true}}));
    Conversation.findById.mockReturnValue(selectable({status:'open',humanTakeover:true}));
    await runInboundSmsLifecycleAfterClaim({...base(),conversation:{...base().conversation,humanTakeover:false}});
    expect(Conversation.findById).toHaveBeenCalledWith('c1');
    expect(Lead.findById).not.toHaveBeenCalled();
    expect(AutomationTriggerService.schedule).not.toHaveBeenCalled();
  });
  test('fresh release from staff ownership still permits eligible follow-up', async () => {
    Business.findById.mockReturnValue(selectable({features:{automatedFollowUpEnabled:true}}));
    Conversation.findById.mockReturnValue(selectable({status:'open',humanTakeover:false,bookingState:{status:'idle'}}));
    Lead.findById.mockReturnValue(selectable({status:'new',serviceNeeded:'Plumbing',address:''}));
    await runInboundSmsLifecycleAfterClaim({...base(),conversation:{...base().conversation,humanTakeover:true}});
    expect(AutomationTriggerService.schedule).toHaveBeenCalledTimes(1);
  });
});


test('matching request-local safety assessment avoids a repeat scan and retains durable lifecycle writes', async () => {
  jest.clearAllMocks();
  classifyInboundSmsCommand.mockReturnValue({handled:false});
  const input=base();
  await runInboundSmsLifecycleAfterClaim({...input,inboundSafety:{body:input.inboundMessage.body,assessment:{handled:true,category:'emergency'}}});
  expect(evaluateDeterministicInboundGuardrails).not.toHaveBeenCalled();
  expect(AutomationService.cancelObsolete).toHaveBeenCalledTimes(1);
  expect(ConversionEventService.record).toHaveBeenCalledTimes(1);
  expect(Business.findById).not.toHaveBeenCalled();
});
test('reclaimed message with different stored body gets its own safety scan',async()=>{
  jest.clearAllMocks();classifyInboundSmsCommand.mockReturnValue({handled:false});
  evaluateDeterministicInboundGuardrails.mockReturnValueOnce({handled:true,category:'emergency'});
  const input=base();input.inboundMessage.body='I smell gas';
  await runInboundSmsLifecycleAfterClaim({...input,inboundSafety:{body:'ordinary test text',assessment:{handled:false}}});
  expect(evaluateDeterministicInboundGuardrails).toHaveBeenCalledWith({customerMessage:'I smell gas',recentMessages:[]});
  expect(Business.findById).not.toHaveBeenCalled();
});
test('missing assessment cannot suppress the lifecycle safety scan',async()=>{
  jest.clearAllMocks();classifyInboundSmsCommand.mockReturnValue({handled:false});
  const input=base();
  evaluateDeterministicInboundGuardrails.mockReturnValueOnce({handled:true,category:'emergency'});
  await runInboundSmsLifecycleAfterClaim({...input,inboundSafety:{body:input.inboundMessage.body}});
  expect(evaluateDeterministicInboundGuardrails).toHaveBeenCalledTimes(1);
});
