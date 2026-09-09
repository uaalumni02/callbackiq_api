import { evaluateDeterministicInboundGuardrails, getEmergencyReply } from '../../src/helpers/ai/aiGuardrails.js';
import { bookingEvidence } from '../../src/services/ownerExperience.service.js';
import AlertService from '../../src/services/alert.service.js';
const cases = [
 ['plumbing', 'My house is flooding', 'flood'],
 ['hvac', 'No heat and dangerously cold with a newborn', 'temperature'],
 ['hvac', 'I smell gas by the furnace', 'gas'],
 ['electrical', 'My electrical panel is sparking', 'electrical'],
 ['roofing', 'The roof is collapsing', 'structural'],
 ['restoration', 'Water is pouring through the ceiling', 'flood'],
 ['garage_door', 'Someone is trapped under the door', 'trapped'],
 ['locksmith', 'A child is locked inside', 'trapped'],
 ['landscaping', 'A tree fell onto the house', 'structural'],
];
test.each(cases)('%s selects hazard-specific instructions for %s', (_trade, text, hazardType) => {
 const result = evaluateDeterministicInboundGuardrails({ customerMessage: text });
 expect(result).toMatchObject({ handled: true, category: 'emergency', hazardType });
 expect(result.reply).toBe(getEmergencyReply(hazardType));
 expect(result.reply).not.toMatch(/will follow up|has been alerted|will call|will contact/);
 if (hazardType !== 'flood') expect(result.reply).not.toMatch(/water supply|shutoff/);
});
test.each(['Please install a smoke detector', 'Please replace the carbon monoxide alarm', 'No smoke or sparking', 'The AC is not cooling', 'Do you offer emergency appointments?', '911 Main Street'])('routine/negated/availability text does not assert a current emergency: %s', customerMessage => {
 expect(evaluateDeterministicInboundGuardrails({ customerMessage }).category).not.toBe('emergency');
});
test.each(['Please replace the smoke detector; there is smoke in the kitchen', 'Please inspect the carbon monoxide alarm that is going off', 'No smoke earlier but the panel is sparking now'])('equipment and negation never suppress later affirmed danger: %s', customerMessage => {
 expect(evaluateDeterministicInboundGuardrails({ customerMessage }).category).toBe('emergency');
});
test.each(cases)('%s safety alert prioritizes current danger over routine scheduling', async (_trade, text) => {
 const create = jest.spyOn(AlertService, 'create').mockResolvedValue({ alert: { _id: 'a' } });
 try {
  await AlertService.createHumanHandoffAlert({ businessId: 'b', customerMessage: text, providerMessageId: 'm', lead: { serviceNeeded: 'Original service' }, result: { messageCategory: 'emergency', urgency: 'emergency', handoff: { reason: 'intake_follow_up' } } });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'safety_emergency', priority: 'critical', actionRequired: true, title: expect.stringMatching(/safety concern/), recommendedAction: expect.stringMatching(/latest safety concern/), lastCustomerMessage: text }));
 } finally { create.mockRestore(); }
});
test('owner dashboard shows manual review while retaining the underlying booking state', () => {
 const evidence = bookingEvidence({ lead: { urgency: 'emergency' }, conversation: { bookingState: { status: 'not_started' }, orchestration: { handoffReason: 'intake_complete' }, conversationMemory: { urgency: 'medium' } } });
 expect(evidence).toMatchObject({ stage: 'not_started', stageLabel: 'Awaiting business review', urgency: 'emergency' });
 const pending = bookingEvidence({ lead: {}, conversation: { bookingState: { status: 'pending_business_confirmation' } } });
 expect(pending.stageLabel).toBe('Awaiting business confirmation');
});
