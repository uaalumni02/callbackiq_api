import { bookingTransitionChanges } from '../../src/services/booking/requestBookingState.js';
import Appointment from '../../src/models/appointment.js';
import cancelAppointment from '../../src/helpers/ai/tools/cancelAppointment.tool.js';
import { handleExistingBookingTurn } from '../../src/services/booking/existingBookingTurn.service.js';

jest.mock('../../src/models/appointment.js', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock('../../src/helpers/ai/tools/cancelAppointment.tool.js', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const fixture = (overrides = {}) => {
  const updateState = jest.fn().mockResolvedValue(undefined);
  return {
    status: 'pending_business_confirmation',
    activeConversation: { bookingState: { appointment: 'a1' } },
    business: { _id: 'b1' },
    bookingChannel: 'sms',
    text: 'Any update?',
    formatSlot: jest.fn().mockReturnValue('Friday at 2 PM'),
    updateState,
    saveBookingTransition: (conversation, event, details) => updateState(conversation, bookingTransitionChanges(event, details)),
    ...overrides,
  };
};

beforeEach(() => jest.resetAllMocks());

test('an expired hold remains a staff review with no confirmed appointment claim', async () => {
  Appointment.findOne.mockResolvedValue({ status: 'failed', failureReason: 'The hold expired.' });
  const input = fixture();
  const outcome = await handleExistingBookingTurn(input);
  expect(outcome.handled).toBe(true);
  expect(outcome.result.reply).toMatch(/no longer|not confirmed|review/i);
  expect(input.updateState).toHaveBeenCalledWith(input.activeConversation, {
    expiresAt: null, lastError: 'approval_needs_recheck',
  });
});

test('a confirmed provider-backed record projects as booked and says when', async () => {
  const saved = { status: 'confirmed', timezone: 'America/New_York' };
  Appointment.findOne.mockResolvedValue(saved);
  const input = fixture();
  const outcome = await handleExistingBookingTurn(input);
  expect(Appointment.findOne).toHaveBeenCalledWith({ _id: 'a1', business: 'b1' });
  expect(outcome.result.reply).toMatch(/confirmed for Friday at 2 PM/);
  expect(input.formatSlot).toHaveBeenCalledWith(saved, saved.timezone);
  expect(input.updateState).toHaveBeenCalledWith(input.activeConversation, {
    status: 'booked', expiresAt: null, lastError: '',
  });
});

test('a valid hold remains pending and the existing state is retained', async () => {
  Appointment.findOne.mockResolvedValue({ status: 'held' });
  const input = fixture();
  const outcome = await handleExistingBookingTurn(input);
  expect(outcome.result.reply).toMatch(/awaiting business approval/);
  expect(input.updateState).not.toHaveBeenCalled();
});

test.each([['missing record', 'a1', null], ['unlinked record', null, null], ['failed record', 'a1', { status: 'failed' }]])(
  'returns to timing collection for a %s',
  async (_, appointment, record) => {
    Appointment.findOne.mockResolvedValue(record);
    const input = fixture({ activeConversation: { bookingState: { appointment } } });
    const outcome = await handleExistingBookingTurn(input);
    expect(outcome.result.reply).toMatch(/could not be confirmed/);
    expect(input.updateState).toHaveBeenCalledWith(input.activeConversation, {
      status: 'collecting_preference', appointment: null, selectedSlot: null,
      offeredSlots: [], expiresAt: null, lastError: 'business_approval_unavailable',
    });
    if (!appointment) expect(Appointment.findOne).not.toHaveBeenCalled();
  },
);

test.each(['sms', 'voice'])('cancels a booked appointment when requested by %s', async (bookingChannel) => {
  const input = fixture({ status: 'booked', text: 'Cancel my appointment', bookingChannel });
  const outcome = await handleExistingBookingTurn(input);
  expect(cancelAppointment).toHaveBeenCalledWith({
    business: input.business, appointmentId: 'a1',
    reason: `Customer requested cancellation by ${bookingChannel === 'sms' ? 'SMS' : 'voice'}.`,
  });
  expect(outcome.result.reply).toMatch(/has been canceled/);
  expect(input.updateState).toHaveBeenCalledWith(input.activeConversation, expect.objectContaining({
    status: 'not_started', appointment: null,
  }));
});

test('a failed cancellation keeps the booking projection and routes follow-up', async () => {
  cancelAppointment.mockRejectedValueOnce(new Error('provider unavailable'));
  const input = fixture({ status: 'booked', text: 'Cancel my appointment' });
  const outcome = await handleExistingBookingTurn(input);
  expect(outcome.result.reply).toMatch(/couldn’t confirm the cancellation automatically/);
  expect(input.updateState).not.toHaveBeenCalled();
});

test.each(['R', 'Please change the time'])('reopens collection for an explicit reschedule request %s', async (text) => {
  const input = fixture({ status: 'booked', text });
  const outcome = await handleExistingBookingTurn(input);
  expect(Appointment.updateOne).toHaveBeenCalledWith(
    { _id: 'a1', business: 'b1' },
    { $set: { customerRescheduleRequestedAt: expect.any(Date) } },
  );
  expect(outcome.result.reply).toMatch(/What new day and time/);
  expect(input.updateState).toHaveBeenCalledWith(input.activeConversation, {
    status: 'collecting_preference', lastError: 'reschedule_requested',
  });
});

test('the C response acknowledges an existing booking and requires it to still be confirmed', async () => {
  const input = fixture({ status: 'booked', text: 'C' });
  Appointment.findOneAndUpdate.mockResolvedValueOnce({ timezone: 'America/New_York' }).mockResolvedValueOnce(null);
  expect((await handleExistingBookingTurn(input)).result.reply).toMatch(/is confirmed/);
  await expect(handleExistingBookingTurn(input)).resolves.toEqual({ handled: false });
  expect(Appointment.findOneAndUpdate).toHaveBeenCalledWith(
    { _id: 'a1', business: 'b1', status: 'confirmed' },
    { $set: { customerConfirmedAt: expect.any(Date) } },
    { returnDocument: 'after' },
  );
});

test('an ordinary YES does not confirm the appointment again', async () => {
  await expect(handleExistingBookingTurn(fixture({ status: 'booked', text: 'YES' })))
    .resolves.toEqual({ handled: false });
  expect(Appointment.findOneAndUpdate).not.toHaveBeenCalled();
});
