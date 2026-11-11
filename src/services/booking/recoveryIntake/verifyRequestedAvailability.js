import { extractCustomerPostalCode, filterAutomatedSlots, filterSlotsByTimePreference, getAvailability, logOperationalError, requestEvidenceKey, requestStaffSchedulingReview, searchServices, slotLabel } from './context.js';

export async function verifyRequestedAvailability(context) {
  const { state, now, timezone, lead, business, checkActive, conversation, range, time, sameDayRequest, text, channel, ask } = context;
let availabilityNote = "I couldn't verify that time's availability; it needs team review.";
  let ready = true;
  state.availability = { status: 'not_checked', reason: 'service_match_unverified', checkedAt: now.toISOString(), timezone };
  try {
    const postalCode = extractCustomerPostalCode(lead.address);
    const area = state.coverage;
    if (area.supported !== true) {
      ready = false; availabilityNote = 'That address is outside the configured service area. Is there another service address?';
    } else {
      const services = await searchServices({ businessId: business._id, query: lead.serviceNeeded }); checkActive();
      if (services.length === 1 && Number.isFinite(services[0].score) && services[0].score > 0) {
        const available = await getAvailability({ business, leadId: lead._id, conversationId: conversation._id, serviceQuery: lead.serviceNeeded, serviceOfferingId: services[0].id, startDate: range.startDate, endDate: range.endDate, postalCode }); checkActive();
        if (available.supportedServiceArea === false) { state.availability = { status: 'not_checked', reason: 'coverage_unverified' }; ready = false; availabilityNote = 'That address needs a service-area review before scheduling.'; }
        else if (Array.isArray(available.slots)) {
          const future = filterAutomatedSlots(available.slots, now);
          const matches = filterSlotsByTimePreference(future, time, timezone);
          if (matches.length) {
            availabilityNote = `${slotLabel(matches[0], timezone)} is currently available, subject to business approval.`;
            state.availability = { status: 'available', checkedAt: now.toISOString(), serviceOfferingId: String(services[0].id), startAt: matches[0].startAt, endAt: matches[0].endAt, timezone, provider: available.provider || '', evidenceKey: requestEvidenceKey({ lead, conversation, state }) };
          }
          else {
            ready = false;
            state.availability.status = 'no_matching_slot';
            const alternatives = future.slice(0, 2).map(slot => slotLabel(slot, timezone));
            availabilityNote = alternatives.length ? `That time isn't available. Current openings: ${alternatives.join(' or ')}. Which works for you?` : 'There are no eligible openings for that requested time under the business scheduling rules. What later day could work?' ;
          }
        }
      }
    }
  } catch (error) {
    if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
    state.availability = { status: 'check_failed', reason: 'availability_lookup_failed', checkedAt: now.toISOString(), timezone };
    logOperationalError('intake.availability_lookup_failed', error, { businessId: business._id });
    // A provider failure is unknown availability, never an empty calendar or a confirmed slot.
  }
  if (!ready && sameDayRequest && state.availability.status === 'no_matching_slot') {
    return { completed: true, value: requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now }) };
  }
  if (!ready) return { completed: true, value: ask('available_preference', availabilityNote) };
  return { completed: false, context: { availabilityNote, ready } };
}
