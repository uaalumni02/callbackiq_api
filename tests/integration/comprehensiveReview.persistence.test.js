// Real unique indexes, durable markers and process-independent replay. Providers
// are blocked by the standard test guard. This suite always uses a private DB.
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Appointment from '../../src/models/appointment.js';
import Lead from '../../src/models/lead.js';
import CallLog from '../../src/models/callLog.js';
import ConversionEvent from '../../src/models/conversionEvent.js';
import Alert from '../../src/models/alert.js';
import Notice from '../../src/models/appointmentNotificationJob.js';
import Lease from '../../src/models/productionOperationLease.js';
import Service from '../../src/models/serviceOffering.js';
import Policy from '../../src/models/schedulingPolicy.js';
import ConversionService from '../../src/services/conversionEvent.service.js';
import AlertService from '../../src/services/alert.service.js';
import AppointmentService from '../../src/services/scheduling/appointment.service.js';
import { projectionMarker, tryRepairAppointmentProjections, repairPendingAppointmentProjections } from '../../src/services/scheduling/appointmentProjection.service.js';
let mongo, business, lead, appointment;
const oid = () => new mongoose.Types.ObjectId();
beforeAll(async () => {
 mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
 await mongoose.connect(mongo.getUri());
 await Promise.all([Appointment.init(), Lead.init(), CallLog.init(), ConversionEvent.init(), Alert.init(), Notice.init(), Lease.init()]);
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
 for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
 business = oid();
 lead = await Lead.create({ business, customerName: 'Test Customer', serviceNeeded: 'Inspection', phone: '+14045550123', source: 'missed_call' });
 const service = await Service.create({ business, name: 'Inspection', durationMinutes: 60 });
 await Policy.create({ business, postAppointmentFollowUpEnabled: true });
 appointment = await Appointment.create({ business, lead: lead._id, serviceOffering: service._id,
   idempotencyKey: `comprehensive-review:${lead._id}`,
   customerPhone: lead.phone, startAt: new Date(Date.now()+86400000), endAt: new Date(Date.now()+90000000),
   status: 'confirmed', confirmedAt: new Date(), timezone: 'UTC', source: 'sms', bookedBy: 'staff',
   bookingProjection: projectionMarker() });
 await CallLog.create({ business, lead: lead._id, from: lead.phone, to: '+14045550199', status: 'missed' });
});
afterEach(() => jest.restoreAllMocks());
test.each(['lead', 'call', 'event', 'alert'])('saved booking converges after %s fails and a fresh worker reads pending work', async boundary => {
 const target = { lead: [Lead, 'updateOne'], call: [CallLog, 'updateMany'], event: [ConversionService, 'record'], alert: [AlertService, 'createBookedJobAlert'] }[boundary];
 const fault = jest.spyOn(...target).mockRejectedValueOnce(new Error('injected boundary failure'));
 await tryRepairAppointmentProjections(appointment);
 expect((await Appointment.findById(appointment._id)).bookingProjection.pending).toBe(true);
 fault.mockRestore();
 await repairPendingAppointmentProjections({ now: new Date(Date.now()+120000) });
 await repairPendingAppointmentProjections({ now: new Date(Date.now()+120000) });
 expect((await Appointment.findById(appointment._id)).bookingProjection.pending).toBe(false);
 expect((await Lead.findById(lead._id)).recovered).toBe(true);
 expect((await CallLog.findOne({ business })).recovered).toBe(true);
 expect(await ConversionEvent.countDocuments({ business, type: 'appointment_booked' })).toBe(1);
 expect(await Alert.countDocuments({ business, type: 'booked_job' })).toBe(1);
});
test('completion commits despite event failure, repairs once and a revenue correction cannot resend a sent follow-up', async () => {
 await tryRepairAppointmentProjections(appointment);
 const fault = jest.spyOn(ConversionService, 'record').mockRejectedValueOnce(new Error('event insert unavailable'));
 const saved = await AppointmentService.update({ businessId: business, appointmentId: appointment._id, changes: { status: 'completed', actualRevenue: 300 } });
 expect(saved.status).toBe('completed'); expect(saved.completionProjection.pending).toBe(true);
 fault.mockRestore();
 await repairPendingAppointmentProjections({ now: new Date(Date.now()+120000) });
 expect(await ConversionEvent.countDocuments({ business, type: 'job_completed' })).toBe(1);
 const followUp = await Notice.findOne({ business, appointment: appointment._id, key: 'follow_up' });
 expect(followUp).toBeTruthy();
 await Notice.updateOne({ _id: followUp._id }, { $set: { status: 'sent', providerMessageId: 'SMstable' } });
 await AppointmentService.update({ businessId: business, appointmentId: appointment._id, changes: { actualRevenue: 725 } });
 const current = await Appointment.findById(appointment._id);
 expect(current.actualRevenue).toBe(725); expect(current.completionProjection.pending).toBe(false);
 expect((await Lead.findById(lead._id)).actualRevenue).toBe(725);
 expect(await Notice.countDocuments({ business, appointment: appointment._id, key: 'follow_up' })).toBe(1);
 expect((await Notice.findById(followUp._id)).status).toBe('sent');
 expect((await ConversionEvent.findOne({ business, type: 'job_completed' })).actualRevenue).toBe(300);
});
test('worker repair cannot modify another business projection', async () => {
 await repairPendingAppointmentProjections({ businessId: oid(), now: new Date(Date.now()+120000) });
 expect((await Appointment.findById(appointment._id)).bookingProjection.pending).toBe(true);
 expect(await ConversionEvent.countDocuments()).toBe(0);
});
