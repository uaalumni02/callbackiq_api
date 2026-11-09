import { applyCustomerAddressRevision } from '../../src/services/messaging/customerRequestRevision.service.js';

test('an address revision retires unbooked offers with the same durable journal write', async () => {
  const conversation = {
    _id: 'conversation-1', status: 'open',
    bookingState: { status: 'offering_slots', offeredSlots: [{ startAt: new Date() }] },
    conversationMemory: { recoveryIntake: {} }, save: jest.fn().mockResolvedValue(),
  };
  const lead = { _id: 'lead-1', address: '125 Main Street, Atlanta GA 30303', save: jest.fn().mockResolvedValue() };

  await expect(applyCustomerAddressRevision({
    business: { _id: 'business-1' }, lead, conversation,
    customerMessage: 'My address is 970 Sidney Marcus Blvd NE Atlanta GA 30324', turnId: 'turn-1',
  })).resolves.toEqual({ addressChanged: true });

  expect(conversation.bookingState).toEqual({ status: 'not_started', offeredSlots: [], selectedSlot: null, expiresAt: null });
  expect(conversation.conversationMemory.recoveryIntake.addressRevision).toMatchObject({ applied: true });
  expect(lead.address).toContain('970 Sidney Marcus');
  expect(conversation.save.mock.invocationCallOrder[0]).toBeLessThan(lead.save.mock.invocationCallOrder[0]);
});
