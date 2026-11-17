import { qualificationChanges } from '../../src/services/leadQualification.policy.js';
import { stageProviderConfirmedAppointment, stageProviderFailure, stageCanceledAppointment } from '../../src/services/stateTransitions/appointmentCommands.js';
import { activeAppointmentFilter } from '../../src/services/scheduling/appointmentStatePolicy.service.js';
test('qualification policy preserves terminal staff outcomes and never lowers safety urgency', () => {
  for (const status of ['booked', 'lost', 'spam']) expect(qualificationChanges({ status, urgency: 'emergency' }, { status: 'contacted', urgency: 'low', business: 'foreign', summary: 'new' }))
    .toEqual({ status, urgency: 'emergency', summary: 'new' });
});
test('all appointment decision commands enforce their shared predecessor policy', () => {
  expect(() => stageProviderConfirmedAppointment({ appointment: { status: 'canceled' } })).toThrow('Invalid appointment transition');
  expect(() => stageProviderFailure({ appointment: { status: 'completed' } })).toThrow('Invalid appointment transition');
  expect(stageCanceledAppointment({ appointment: { status: 'cancel_pending' } })).toBe('canceled');
  expect(activeAppointmentFilter().status.$in).toContain('cancel_pending');
});
