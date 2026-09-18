import crypto from 'node:crypto';
import { addressFromTurn } from '../booking/customerAddress.service.js';
import AlertService from '../alert.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';

// Called only after consent/safety/withdrawal precedence. A question or callback
// must not discard a supplied address. Journal before projecting facts so a retry
// repairs a failed lead/alert write without resurrecting a stale offer.
export async function applyCustomerAddressRevision({ business, lead, conversation, customerMessage, turnId = '', recentMessages = [] }) {
  if (!lead?.save || !conversation?.save || conversation.humanTakeover || conversation.aiEnabled === false ||
      ['closed', 'archived'].includes(conversation.status)) return { addressChanged: false };
  const check = () => { assertDistributedLeaseActive(); assertVoiceTurnActive(); };
  const key = crypto.createHash('sha256').update(`${turnId}:${customerMessage}`).digest('hex');
  let intake = conversation.conversationMemory?.recoveryIntake || {};
  let revision = intake.addressRevision;
  if (revision?.key !== key) {
    const address = addressFromTurn({ customerMessage, conversation, recentMessages, knownAddress: lead.address || '' });
    if (!address || address.trim().toLowerCase() === String(lead.address || '').trim().toLowerCase()) return { addressChanged: false };
    revision = { key, address, applied: false };
    intake = { ...intake, addressRevision: revision, availability: { status: 'unknown' } };
    const knownLocation = lead.address && !/^(unknown|not provided|n\/a)$/i.test(lead.address);
    if (!conversation.bookingState?.appointment && (knownLocation || ['offering_slots', 'awaiting_confirmation', 'booking'].includes(conversation.bookingState?.status))) {
      conversation.bookingState = { status: 'not_started', offeredSlots: [], selectedSlot: null, expiresAt: null };
      conversation.markModified?.('bookingState');
    }
    if (conversation.set) conversation.set('conversationMemory.recoveryIntake', intake);
    else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: intake };
    conversation.markModified?.('conversationMemory.recoveryIntake');
    check(); await conversation.save(); check();
  }
  if (!revision.applied) {
    lead.address = revision.address;
    check(); await lead.save(); check();
    if (conversation.bookingState?.appointment) {
      const saved = await AlertService.create({ businessId: business._id, leadId: lead._id, conversationId: conversation._id,
        type: 'system', priority: 'high', actionRequired: true, title: 'Customer changed the service address',
        message: 'Review the latest customer address before dispatch. The existing appointment address has not been changed.',
        lastCustomerMessage: customerMessage, recommendedAction: 'Verify service area and availability and update the appointment explicitly.',
        dedupeKey: `address-revision:${conversation._id}:${key}` });
      if (!saved?.alert?._id) throw Object.assign(new Error('Address review was not saved'), { code: 'STAFF_ACTION_NOT_SAVED' });
    }
    check(); revision.applied = true;
    conversation.markModified?.('conversationMemory.recoveryIntake');
    await conversation.save(); check();
  }
  return { addressChanged: true };
}
