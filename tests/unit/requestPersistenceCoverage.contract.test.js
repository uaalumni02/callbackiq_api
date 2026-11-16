jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/services/booking/recoveryIntake/context.js', () => ({
  ...jest.requireActual('../../src/services/booking/recoveryIntake/context.js'),
  guardServiceRequest: jest.fn().mockResolvedValue(null),
}));
import Alert from '../../src/models/alert.js';
import AlertService from '../../src/services/alert.service.js';
import { captureRequestFacts } from '../../src/services/booking/recoveryIntake/captureRequestFacts.js';
import { guardServiceRequest } from '../../src/services/booking/recoveryIntake/context.js';
import { handleConversationControl } from '../../src/services/conversationControl.service.js';
import { readRequestWorkflow } from '../../src/services/businessRequestWorkflow.service.js';

beforeEach(() => { jest.clearAllMocks(); guardServiceRequest.mockResolvedValue(null); });
afterEach(() => jest.restoreAllMocks());
function intake() {
  return { customerMessage: 'Please continue', recentMessages: [], channel: 'sms', business: { _id: 'tenant' },
    lead: { _id: 'lead', address: '', save: jest.fn().mockResolvedValue(null) },
    conversation: { _id: 'conversation', status: 'open', bookingState: {
      status: 'collecting_service', streetAddress: '970 Sidney Marcus Blvd NE Atlanta GA 30324',
    }, conversationMemory: {} } };
}

test('[maintenance-coverage] split-storage address repair is saved before eligibility evaluates the request', async () => {
  const input = intake();
  guardServiceRequest.mockImplementation(async ({ lead }) => {
    expect(lead.address).toMatch(/970 Sidney Marcus/);
    expect(input.lead.save).toHaveBeenCalledTimes(1);
    return null;
  });
  const result = await captureRequestFacts(input);
  expect(result.completed).toBe(false);
  expect(input.lead.address).toMatch(/30324/);
  expect(input.lead.save).toHaveBeenCalledTimes(1);
  expect(guardServiceRequest).toHaveBeenCalledTimes(1);
});

test('[maintenance-coverage] a failed address projection save prevents eligibility and acknowledgement', async () => {
  const input = intake();input.lead.save.mockRejectedValueOnce(Error('projection unavailable'));
  await expect(captureRequestFacts(input)).rejects.toThrow('projection unavailable');
  expect(guardServiceRequest).not.toHaveBeenCalled();
});

test('[maintenance-coverage] a legacy read-only lead still receives the saved address in memory', async () => {
  const input = intake();delete input.lead.save;
  expect((await captureRequestFacts(input)).completed).toBe(false);
  expect(input.lead.address).toMatch(/970 Sidney Marcus.*30324/);
  expect(guardServiceRequest).toHaveBeenCalledWith(expect.objectContaining({ lead: input.lead }));
});

test('[maintenance-coverage] withdrawal preserves conversation and staff review when the lead has no save method', async () => {
  const lead = { _id: 'lead', serviceNeeded: 'Sink repair' };
  const conversation = { _id: 'conversation', status: 'open', bookingState: { status: 'not_started' },
    conversationMemory: {}, save: jest.fn().mockResolvedValue(null) };
  AlertService.create.mockResolvedValueOnce({ alert: { _id: 'review' } });
  const result = await handleConversationControl({ business: { _id: 'tenant' }, lead, conversation,
    customerMessage: 'I do not need your service' });
  expect(result.reply).toMatch(/withdrawn/);
  expect(conversation.save).toHaveBeenCalledTimes(2);
  expect(conversation.conversationMemory.recoveryIntake.withdrawnAt).toBeInstanceOf(Date);
  expect(conversation.bookingState.offeredSlots).toEqual([]);
  expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Customer withdrew service request' }));
  expect(lead.status).toBeUndefined();
});

test('[maintenance-coverage] an orphaned review stays readable without inventing lead or conversation projections', async () => {
  const alert = { _id: '507f1f77bcf86cd799439011', business: 'tenant', type: 'integration_failure',
    metadata: {}, priority: 'high', createdAt: new Date('2026-09-21T20:00:00Z'), title: 'Provider review' };
  const query = { session: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(alert) };
  jest.spyOn(Alert, 'findOne').mockReturnValue(query);
  const result = await readRequestWorkflow({ businessId: 'tenant', alertId: alert._id });
  expect(Alert.findOne).toHaveBeenCalledWith({ _id: alert._id, business: 'tenant' });
  expect(query.session).toHaveBeenCalledWith(null);
  expect(result).toMatchObject({ lead: null, conversation: null, appointment: null, journey: null });
  expect(result.review._id).toBe(alert._id);
  expect(result.version).toMatch(/^[a-f0-9]{64}$/);
});
