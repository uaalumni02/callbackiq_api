import Appointment from '../../src/models/appointment.js';
import Lead from '../../src/models/lead.js';
import Service from '../../src/models/serviceOffering.js';
import Alert from '../../src/models/alert.js';
import Conversion from '../../src/services/conversionEvent.service.js';
import AlertService from '../../src/services/alert.service.js';
import Intervention from '../../src/services/intervention.service.js';
import { schedulePostAppointmentFollowUp } from '../../src/services/scheduling/appointmentNotification.service.js';
import { withDistributedLease } from '../../src/services/distributedLease.service.js';
import { projectionMarker, tryRepairAppointmentProjections, repairPendingAppointmentProjections } from '../../src/services/scheduling/appointmentProjection.service.js';
jest.mock('../../src/models/appointment.js', () => ({ __esModule: true, default: { findOne: jest.fn(), updateOne: jest.fn(), find: jest.fn() } }));
jest.mock('../../src/models/lead.js', () => ({ __esModule: true, default: { findOne: jest.fn(), updateOne: jest.fn() } }));
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/alert.js', () => ({ __esModule: true, default: { updateMany: jest.fn() } }));
jest.mock('../../src/services/conversionEvent.service.js', () => ({ __esModule: true, default: { markAppointmentBooked: jest.fn(), record: jest.fn() } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createBookedJobAlert: jest.fn() } }));
jest.mock('../../src/services/intervention.service.js', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/services/scheduling/appointmentNotification.service.js', () => ({ schedulePostAppointmentFollowUp: jest.fn() }));
jest.mock('../../src/services/distributedLease.service.js', () => ({ assertDistributedLeaseActive: jest.fn(), withDistributedLease: jest.fn() }));
let appointment;
beforeEach(() => {
 jest.resetAllMocks();
 withDistributedLease.mockImplementation(async (_key, action) => ({ acquired: true, value: await action() }));
 Appointment.updateOne.mockResolvedValue({ matchedCount: 1 }); Lead.updateOne.mockResolvedValue({ matchedCount: 1 });
 Lead.findOne.mockResolvedValue({ _id: 'lead', source: 'missed_call' }); Service.findOne.mockResolvedValue({ name: 'Service' });
 Alert.updateMany.mockResolvedValue({}); Intervention.create.mockResolvedValue({});
 appointment = { _id: 'a', business: 'b', lead: 'lead', serviceOffering: 's', source: 'sms', bookedBy: 'staff',
   confirmedAt: new Date(), completedAt: new Date(), status: 'completed', actualRevenue: 725,
   bookingProjection: projectionMarker(), completionProjection: projectionMarker() };
 Appointment.findOne.mockImplementation(async () => appointment);
});
test.each(['booking', 'booked_alert', 'completion', 'lead', 'follow_up', 'marker'])('repair converges after %s boundary failure and survives a new worker snapshot', async boundary => {
 const method = { booking: Conversion.markAppointmentBooked, booked_alert: AlertService.createBookedJobAlert,
   completion: Conversion.record, lead: Lead.updateOne, follow_up: schedulePostAppointmentFollowUp, marker: Appointment.updateOne }[boundary];
 method.mockRejectedValueOnce(new Error('injected write failure'));
 await tryRepairAppointmentProjections(appointment);
 expect(appointment.bookingProjection.pending || appointment.completionProjection.pending).toBe(true);
 expect(Intervention.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'b', appointmentId: 'a' }));
 // A different object represents reading the persisted pending marker on restart.
 const restarted = structuredClone(appointment);
 Appointment.findOne.mockResolvedValue(restarted);
 await tryRepairAppointmentProjections(restarted);
 expect(restarted.bookingProjection.pending).toBe(false);
 expect(restarted.completionProjection.pending).toBe(false);
 expect(Conversion.record).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'job_completed:a', actualRevenue: 725 }));
});
test('a newer saved revenue correction cannot have its marker erased by stale repair', async () => {
 appointment.bookingProjection.pending = false;
 Appointment.updateOne.mockResolvedValue({ matchedCount: 0 });
 await tryRepairAppointmentProjections(appointment);
 expect(appointment.completionProjection.pending).toBe(true);
 expect(Appointment.updateOne).toHaveBeenCalledWith(expect.objectContaining({ 'completionProjection.token': appointment.completionProjection.token }), expect.any(Object));
 expect(Lead.updateOne.mock.calls[0][0].$or).toContainEqual({ completionProjectionAt: { $lte: appointment.completionProjection.at } });
});
test('contended lease leaves the persisted obligation for another worker', async () => {
 withDistributedLease.mockResolvedValue({ acquired: false });
 await tryRepairAppointmentProjections(appointment);
 expect(Conversion.record).not.toHaveBeenCalled(); expect(appointment.completionProjection.pending).toBe(true);
});
test('maintenance reads bounded, due, business-scoped pending work', async () => {
 const query = { sort: jest.fn(() => query), limit: jest.fn(() => query), lean: async () => [] };
 Appointment.find.mockReturnValue(query);
 await repairPendingAppointmentProjections({ businessId: 'b', limit: 3 });
 expect(Appointment.find.mock.calls[0][0]).toMatchObject({ business: 'b' }); expect(query.limit).toHaveBeenCalledWith(3);
});

test('pending booking repair reads latest saved status and does not resurrect a canceled visit', async () => {
 appointment.status = 'canceled'; appointment.completionProjection.pending = false;
 await tryRepairAppointmentProjections(appointment);
 expect(Conversion.markAppointmentBooked).not.toHaveBeenCalled();
 expect(appointment.bookingProjection.pending).toBe(false);
 expect(Lead.updateOne).toHaveBeenCalledWith(expect.objectContaining({ appointment: 'a', business: 'b' }), { $set: { appointment: null } });
});
