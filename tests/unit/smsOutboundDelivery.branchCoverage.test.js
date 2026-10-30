// Characterization tests for Stage 3. No production implementation changes.
// Keep these tests independent of Twilio, Redis and MongoDB external connections.
import { createSmsOutboundDelivery } from '../../src/services/messaging/smsOutboundDelivery.adapter.js';

const input = (changes = {}) => ({
  business: { _id: 'tenant', phone: '+15555550000' },
  lead: { _id: 'lead' },
  conversation: { _id: 'conv', customerPhone: '+15555550111' },
  inboundMessage: { _id: 'inbound', body: 'Can you help?' },
  result: { reply: 'We can help.', decision: 'reply', messageCategory: 'service_request' },
  ...changes,
});

function harness(overrides = {}) {
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
  const sendSms = jest.fn().mockResolvedValue({ sid: 'SM1', status: 'sent', body: 'We can help.' });
  const deps = {
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
    ...overrides,
  };
  return { deps, deliver: createSmsOutboundDelivery(deps) };
}

function pendingOutbound(deps) {
  const queued = {
    _id: 'out',
    providerMessageId: '',
    metadata: { source: 'inbound_sms_reply' },
    deliveryAttemptedAt: null,
  };
  deps.Message.create.mockResolvedValue(queued);
  deps.Message.findOneAndUpdate.mockResolvedValue({ ...queued, deliveryAttemptedAt: new Date() });
  deps.Message.findByIdAndUpdate.mockResolvedValue({ ...queued, status: 'sent' });
  return queued;
}

describe('Stage 3 outbound SMS uncovered safety branches', () => {
  test('persistently suppressed reply is terminal, including on retry', async () => {
    const { deps, deliver } = harness();
    deps.Message.findOne.mockResolvedValue({ _id: 'out', providerMessageId: '', status: 'suppressed' });
    await expect(deliver(input())).resolves.toMatchObject({ sent: false, suppressed: true, duplicate: true });
    expect(deps.Message.create).not.toHaveBeenCalled();
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  test('lost send claim reuses accepted provider outcome instead of resending', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.Message.findOneAndUpdate.mockResolvedValue(null);
    deps.Message.findById.mockResolvedValue({ _id: 'out', providerMessageId: 'SM-existing' });
    await expect(deliver(input())).resolves.toMatchObject({ sent: true, duplicate: true });
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  test('lost send claim without provider receipt stays unsent and duplicate', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.Message.findOneAndUpdate.mockResolvedValue(null);
    deps.Message.findById.mockResolvedValue({ _id: 'out', providerMessageId: '' });
    await expect(deliver(input())).resolves.toMatchObject({ sent: false, duplicate: true });
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  test('duplicate-key creation race reloads the existing outbound record', async () => {
    const { deps, deliver } = harness();
    const queued = pendingOutbound(deps);
    deps.Message.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: 11000 }));
    deps.Message.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(queued);
    await expect(deliver(input())).resolves.toMatchObject({ sent: true });
    expect(deps.Message.findOne).toHaveBeenCalledTimes(2);
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
  });

  test('non-duplicate persistence error is not hidden or retried as another send', async () => {
    const { deps, deliver } = harness();
    deps.Message.create.mockRejectedValue(new Error('database write unavailable'));
    await expect(deliver(input())).rejects.toThrow('database write unavailable');
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  test('identity-change suppression raises staff alert without provider send', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.getSmsAutomationSuppressionReason.mockResolvedValue('automation_context_changed');
    await expect(deliver(input())).resolves.toMatchObject({
      sent: false, suppressed: true, reason: 'automation_context_changed',
    });
    expect(deps.AlertService.createSystemAlert).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'high',
    }));
    expect(deps.sendSms).not.toHaveBeenCalled();
    expect(deps.Conversation.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('provider-declared suppression never advances customer conversation', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.sendSms.mockResolvedValue({ suppressed: true, status: 'suppressed', reason: 'customer_opted_out' });
    await expect(deliver(input())).resolves.toMatchObject({ sent: false, suppressed: true });
    expect(deps.SocketService.emitMessageCreated).toHaveBeenCalledTimes(1);
    expect(deps.Conversation.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('essential human handoff bypasses ordinary usage limits, not idempotency', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    const request = input({ result: { ...input().result, handoff: { required: true } } });
    await expect(deliver(request)).resolves.toMatchObject({ sent: true });
    expect(deps.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      bypassUsageLimits: true,
      metadata: expect.objectContaining({ handoffRequired: true }),
    }));
    expect(deps.Message.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('handoff status acknowledgment also bypasses ordinary usage limits', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    const request = input({ result: { ...input().result, handoff: { statusAcknowledgement: true } } });
    await expect(deliver(request)).resolves.toMatchObject({ sent: true });
    expect(deps.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      bypassUsageLimits: true,
      metadata: expect.objectContaining({ handoffStatusAcknowledgement: true }),
    }));
  });

  test('ordinary reply never bypasses usage limits', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    await expect(deliver(input())).resolves.toMatchObject({ sent: true });
    expect(deps.sendSms).toHaveBeenCalledWith(expect.objectContaining({ bypassUsageLimits: false }));
  });

  test('emergency guardrail reply retains safety billing classification', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    const request = input({ result: {
      reply: 'Please call emergency services.', decision: 'send_fixed_response',
      messageCategory: 'emergency', guardrail: { skipAI: true },
    } });
    await expect(deliver(request)).resolves.toMatchObject({ sent: true });
    expect(deps.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      usageCategory: 'safety', actorType: 'webhook',
      metadata: expect.objectContaining({ fixedEmergencyReply: true, generatedBy: 'guardrail' }),
    }));
  });

  test('non-emergency guardrail reply is not marked fixed-emergency', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    const request = input({ result: {
      reply: 'We have your request.', decision: 'send_fixed_response',
      messageCategory: 'service_request', guardrail: { skipAI: true },
    } });
    await expect(deliver(request)).resolves.toMatchObject({ sent: true });
    expect(deps.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      usageCategory: 'guardrail_reply', actorType: 'webhook',
      metadata: expect.objectContaining({ fixedEmergencyReply: false }),
    }));
  });

  test('ordinary provider failure is propagated and not mislabeled uncertain', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.sendSms.mockRejectedValue(new Error('definitive carrier rejection'));
    await expect(deliver(input())).rejects.toThrow('definitive carrier rejection');
    expect(deps.Message.findByIdAndUpdate).toHaveBeenCalledWith(
      'out', expect.objectContaining({
        status: 'failed', deliveryUncertain: false, deliveryAttemptedAt: null,
      }),
    );
    expect(deps.AlertService.createSystemAlert).not.toHaveBeenCalled();
  });

  test('reconciliation-required provider outcome blocks retry and alerts staff', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.sendSms.mockRejectedValue(Object.assign(new Error('delivery must be reconciled'), {
      code: 'SMS_DELIVERY_RECONCILIATION_REQUIRED',
    }));
    await expect(deliver(input())).resolves.toMatchObject({
      sent: false, reason: 'delivery_uncertain',
    });
    expect(deps.AlertService.createSystemAlert).toHaveBeenCalledTimes(1);
    expect(deps.Conversation.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('explicit provider uncertainty is not converted into a normal retry', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.sendSms.mockRejectedValue(Object.assign(new Error('connection dropped after acceptance'), {
      deliveryUncertain: true,
    }));
    await expect(deliver(input())).resolves.toMatchObject({
      sent: false, reason: 'delivery_uncertain',
    });
    expect(deps.AlertService.createSystemAlert).toHaveBeenCalledTimes(1);
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
  });

  test('suppression policy lookup failure stops send and surfaces error', async () => {
    const { deps, deliver } = harness();
    pendingOutbound(deps);
    deps.getSmsAutomationSuppressionReason.mockRejectedValue(new Error('suppression lookup unavailable'));
    await expect(deliver(input())).rejects.toThrow('suppression lookup unavailable');
    expect(deps.sendSms).not.toHaveBeenCalled();
    expect(deps.Message.findByIdAndUpdate).toHaveBeenCalledWith(
      'out', expect.objectContaining({ status: 'failed', deliveryUncertain: false }),
    );
  });
});
