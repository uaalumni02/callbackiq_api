// Stage 3 SMS outbound adapter: additional behavior-based branch characterization.
// No real Twilio, MongoDB, Redis, environment variables or production SMS calls.
import { createSmsOutboundDelivery } from '../../src/services/messaging/smsOutboundDelivery.adapter.js';

const request = (changes = {}) => ({
  business: { _id: 'tenant', phone: '+15555550000' },
  lead: { _id: 'lead' },
  conversation: { _id: 'conv', customerPhone: '+15555550111' },
  inboundMessage: { _id: 'inbound', body: 'Please help' },
  result: { reply: 'We can help.', decision: 'reply', messageCategory: 'service_request' },
  ...changes,
});

function fixture(changes = {}) {
  const Message = {
    updateOne: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue(null),
    findByIdAndUpdate: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
  };
  const Conversation = {
    findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: 'conv' }),
  };
  const AlertService = { createSystemAlert: jest.fn().mockResolvedValue({}) };
  const SocketService = {
    emitMessageCreated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  };
  const sendSms = jest.fn().mockResolvedValue({
    sid: 'SM-test', status: 'sent', body: 'We can help.',
  });
  const dependencies = {
    Message,
    Conversation,
    AlertService,
    SocketService,
    sendSms,
    logOperationalEvent: jest.fn(),
    applySmsProductionInvariants: ({ result }) => result,
    describeSmsWorkflowDecision: () => ({ type: 'reply' }),
    assertDistributedLeaseActive: jest.fn(),
    respectCustomerConstraints: reply => reply,
    getSmsAutomationSuppressionReason: jest.fn().mockResolvedValue(null),
    ...changes,
  };
  return { dependencies, deliver: createSmsOutboundDelivery(dependencies) };
}

function prepareClaim(dependencies) {
  const queued = {
    _id: 'outbound',
    providerMessageId: '',
    deliveryAttemptedAt: null,
    metadata: { source: 'inbound_sms_reply' },
  };
  dependencies.Message.create.mockResolvedValue(queued);
  dependencies.Message.findOneAndUpdate.mockResolvedValue({
    ...queued, deliveryAttemptedAt: new Date('2026-10-30T16:00:00.000Z'),
  });
  dependencies.Message.findByIdAndUpdate.mockResolvedValue({ ...queued, status: 'sent' });
  return queued;
}

describe('Stage 3 SMS delivery residual branches', () => {
  test('no_reply with nonempty text still prevents provider delivery', async () => {
    // Existing no_reply test uses an empty reply; this exercises the other
    // branch of: !reply || result?.decision === 'no_reply'.
    const { dependencies, deliver } = fixture();
    const input = request({ result: {
      reply: 'This text must not be sent.',
      decision: 'no_reply',
      messageCategory: 'service_request',
    } });
    await expect(deliver(input)).resolves.toMatchObject({ sent: false, reason: 'no_reply' });
    expect(dependencies.Message.updateOne).toHaveBeenCalledTimes(1);
    expect(dependencies.Message.findOne).not.toHaveBeenCalled();
    expect(dependencies.sendSms).not.toHaveBeenCalled();
  });

  test('successful provider receipt retains optional encoding, segment and usage metadata', async () => {
    // Earlier fixtures omit these fields; this covers their populated branches.
    const { dependencies, deliver } = fixture();
    prepareClaim(dependencies);
    dependencies.sendSms.mockResolvedValue({
      sid: 'SM-metadata', status: 'sent', body: 'We can help.',
      encoding: 'UCS-2', segmentCount: 2,
      usage: { segments: 2, billable: true },
    });
    await expect(deliver(request())).resolves.toMatchObject({ sent: true });
    expect(dependencies.Message.findByIdAndUpdate).toHaveBeenCalledWith(
      'outbound',
      expect.objectContaining({
        providerMessageId: 'SM-metadata',
        encoding: 'UCS-2',
        segmentCount: 2,
        metadata: expect.objectContaining({ usage: { segments: 2, billable: true } }),
      }),
      expect.objectContaining({ returnDocument: 'after' }),
    );
    expect(dependencies.sendSms).toHaveBeenCalledTimes(1);
  });

  test('nonfixed emergency classification does not falsely claim a fixed emergency response', async () => {
    const { dependencies, deliver } = fixture();
    prepareClaim(dependencies);
    const input = request({ result: {
      reply: 'Your request has been logged.',
      decision: 'reply',
      messageCategory: 'emergency',
      guardrail: { skipAI: true },
    } });
    await expect(deliver(input)).resolves.toMatchObject({ sent: true });
    expect(dependencies.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      usageCategory: 'safety',
      metadata: expect.objectContaining({ fixedEmergencyReply: false }),
    }));
  });

  test('an existing unsent queued outbound record is claimed rather than recreated', async () => {
    const { dependencies, deliver } = fixture();
    const queued = prepareClaim(dependencies);
    dependencies.Message.findOne.mockResolvedValue(queued);
    await expect(deliver(request())).resolves.toMatchObject({ sent: true });
    expect(dependencies.Message.create).not.toHaveBeenCalled();
    expect(dependencies.Message.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(dependencies.sendSms).toHaveBeenCalledTimes(1);
  });

  test('a constrained-away reply never reserves or sends an outbound SMS', async () => {
    const { dependencies, deliver } = fixture({ respectCustomerConstraints: () => '' });
    await expect(deliver(request())).resolves.toMatchObject({ sent: false, reason: 'no_reply' });
    expect(dependencies.Message.updateOne).toHaveBeenCalledTimes(1);
    expect(dependencies.Message.create).not.toHaveBeenCalled();
    expect(dependencies.sendSms).not.toHaveBeenCalled();
  });
});
