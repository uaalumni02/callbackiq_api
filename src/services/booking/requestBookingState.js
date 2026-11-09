// Keep the existing Conversation booking state as the shared record for SMS,
// voice and staff scheduling. Its callers still own the save or atomic update
// so transaction sessions, lease checks and conditional filters stay intact.
const bookingStatePath = (field) => `bookingState.${field}`;

export function bookingStateFields(changes) {
  return Object.fromEntries(
    Object.entries(changes).map(([field, value]) => [bookingStatePath(field), value]),
  );
}

export function bookingStateReplacement(state) {
  return { bookingState: state };
}

export function replaceBookingState(conversation, state, { markModified = false } = {}) {
  conversation.bookingState = state;
  if (markModified) conversation.markModified?.('bookingState');
}

export function applyBookingStateFields(conversation, changes) {
  for (const [path, value] of Object.entries(bookingStateFields(changes))) {
    conversation.set(path, value);
  }
}
