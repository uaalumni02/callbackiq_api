// Keep the existing Conversation booking state as the shared record for SMS,
// voice and staff scheduling. Its callers still own the save or atomic update
// so transaction sessions, lease checks and conditional filters stay intact.
const bookingStatePath = (field) => `bookingState.${field}`;

export function bookingStateFields(changes) {
  return Object.fromEntries(
    Object.entries(changes).map(([field, value]) => [bookingStatePath(field), value]),
  );
}

function bookingStateReplacement(state) {
  return { bookingState: state };
}

function replaceBookingState(conversation, state, { markModified = false } = {}) {
  conversation.bookingState = state;
  if (markModified) conversation.markModified?.('bookingState');
}

export function applyBookingStateFields(conversation, changes) {
  for (const [path, value] of Object.entries(bookingStateFields(changes))) {
    conversation.set(path, value);
  }
}

// Callers may supply event facts. Each transition owns the list of fields it
// can change. The caller still owns its transaction and accompanying updates.
const patch = (fixed, allowed = []) => details => ({
  ...Object.fromEntries(Object.entries(fixed).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])),
  ...Object.fromEntries(allowed.filter(key => Object.hasOwn(details, key)).map(key => [key, details[key]])),
});
const clearedOffer = () => ({ offeredSlots: [], selectedSlot: null, expiresAt: null });
const reset = { status: 'not_started' };
const rejectedPreference = ({ enabled }) => ({
  ...clearedOffer(), status: enabled ? 'collecting_preference' : 'not_started',
  searchStartDate: null, searchEndDate: null, lastCustomerPreference: '',
  lastError: 'customer_rejected_preference',
});
const holdNeedsRecheck = { expiresAt: null, lastError: 'approval_needs_recheck' };
const booked = { status: 'booked', expiresAt: null, lastError: '' };

const updates = new Map([
  ['search_range_selected', patch({}, ['searchStartDate', 'searchEndDate'])],
  ['slots_offered', patch({ status: 'offering_slots', selectedSlot: null, negotiationAttempts: 0, availabilityInquiry: false },
    ['timeOfDay', 'preferredStart', 'preferredEnd', 'offeredSlots', 'lastCustomerPreference', 'lastAvailabilityCheckedAt', 'expiresAt'])],
  ['availability_checked', patch({}, ['negotiationAttempts', 'lastCustomerPreference', 'lastAvailabilityCheckedAt'])],
  ['scheduling_escalated', patch({ status: 'human_takeover' }, ['escalatedAt'])],
  ['alternative_slots_offered', patch({ status: 'offering_slots' }, ['offeredSlots', 'expiresAt'])],
  ['service_requested', patch({ status: 'collecting_service' })],
  ['service_selected', patch({ status: 'collecting_location' }, ['serviceOffering', 'streetAddress', 'postalCode', 'availabilityInquiry'])],
  ['street_address_requested', patch({ status: 'collecting_street_address' }, ['postalCode'])],
  ['postal_code_requested', patch({ status: 'collecting_postal_code' }, ['streetAddress'])],
  ['location_verified', patch({ status: 'collecting_preference' }, ['streetAddress', 'postalCode'])],
  ['booking_confirmed', patch(booked, ['appointment'])],
  ['booking_submitted', patch({ status: 'pending_business_confirmation', lastError: '' }, ['appointment', 'expiresAt'])],
  ['booking_failed', patch({ status: 'failed', expiresAt: null }, ['lastError'])],
  ['reschedule_submitted', patch({ ...clearedOffer(), status: 'booked', lastError: 'reschedule_pending_business_approval' })],
  ['approval_recheck_requested', patch(holdNeedsRecheck)],
  ['approval_observed', patch(booked)],
  ['approval_unavailable', patch({
    ...clearedOffer(), status: 'collecting_preference', appointment: null, lastError: 'business_approval_unavailable',
  })],
  ['booking_canceled', patch({ ...clearedOffer(), ...reset, appointment: null, lastError: '' })],
  ['reschedule_requested', patch({ status: 'collecting_preference', lastError: 'reschedule_requested' })],
  ['preference_rejected', rejectedPreference],
  ['inquiry_offer_expired', patch({ ...clearedOffer(), ...reset })],
  ['inquiry_slot_referred', patch({
    ...clearedOffer(), status: 'human_takeover', availabilityInquiry: false, lastError: 'selected_slot_requires_manual_confirmation',
  }, ['selectedSlot', 'escalatedAt'])],
  ['inquiry_slots_offered', patch({ status: 'offering_slots', selectedSlot: null, availabilityInquiry: true },
    ['serviceOffering', 'offeredSlots', 'lastAvailabilityCheckedAt', 'expiresAt'])],
  ['offer_expired', patch({ ...clearedOffer(), status: 'collecting_preference', lastError: 'offer_expired' })],
  ['voice_transfer_accepted', patch({ status: 'human_takeover' })],
  ['human_escalation_requested', patch({ status: 'human_takeover' }, ['lastError'])],
  ['sms_handoff_recorded', patch({}, ['escalatedAt'])],
  ['request_revision_invalidated_offer', patch({ ...clearedOffer(), ...reset })],
  ['staff_scheduling_facts_corrected', patch({
    ...clearedOffer(), lastAvailabilityCheckedAt: null, preferredStart: null, preferredEnd: null,
    searchStartDate: '', searchEndDate: '', status: 'human_takeover', serviceOffering: null,
  }, ['lastCustomerPreference', 'streetAddress', 'postalCode'])],
  ['staff_request_resolved', patch({ ...clearedOffer(), status: 'human_takeover' })],
]);

const replacements = new Map([
  ['service_eligibility_changed', { fields: () => ({ ...reset }) }],
  ['intake_address_changed', { fields: () => ({ ...reset }) }],
  ['intake_coverage_unavailable', { fields: () => ({ ...reset }), markModified: true }],
  ['request_address_revised', { fields: () => ({ ...clearedOffer(), ...reset }), markModified: true }],
  ['request_withdrawn', { fields: () => ({ ...clearedOffer(), ...reset, appointment: null }), markModified: true }],
  ['staff_review_requested', {
    fields: (_, current) => ({
      ...(current?.toObject?.() || current || {}), ...clearedOffer(), status: 'collecting_preference',
    }),
    markModified: true,
  }],
  ['intake_preference_rejected', {
    fields: (details, current) => ({ ...current, ...rejectedPreference(details) }),
    markModified: true,
  }],
  ['intake_booking_started', {
    fields: (_, current) => ({ ...current, status: 'collecting_service' }),
    markModified: true,
  }],
]);

export function bookingTransitionChanges(event, details = {}) {
  const transition = updates.get(event);
  if (!transition) throw new TypeError(`Unknown booking patch transition: ${event}`);
  return transition(details);
}

export function bookingTransitionFields(event, details = {}) {
  if (event === 'conversation_lead_relinked') return bookingStateReplacement({ ...reset });
  return bookingStateFields(bookingTransitionChanges(event, details));
}

export function applyBookingStateTransition(conversation, event, details = {}) {
  const replacement = replacements.get(event);
  if (replacement) {
    replaceBookingState(conversation, replacement.fields(details, conversation.bookingState), replacement);
  } else {
    applyBookingStateFields(conversation, bookingTransitionChanges(event, details));
  }
}
