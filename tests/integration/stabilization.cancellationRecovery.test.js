import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import { reconcileAppointmentCancellations } from '../../src/services/scheduling/appointmentCancellationRecovery.service.js';
import Appointment from '../../src/models/appointment.js';
import { stabilizationSchedulingFixture } from '../setup/stabilizationSchedulingFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
beforeAll(connectTestDB); afterEach(clearTestDB); afterAll(closeTestDB);
test('a cancellation accepted before response loss is durably retried by maintenance', async () => {
  const f = await stabilizationSchedulingFixture();
  await Business.create({ ...f.business, owner: new mongoose.Types.ObjectId() });
  f.provider.cancelAppointment.mockImplementationOnce(async () => {
    f.events.delete('event');
    throw Object.assign(new Error('response lost after provider accepted'), { code: 'ETIMEDOUT' });
  });
  await expect(f.cancel()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  const pending = await Appointment.findById(f.original._id);
  expect(pending.status).toBe('cancel_pending');
  expect(pending.cancellationIntent.key).toBe(`cancel:${pending._id}`);
  await Appointment.updateOne({ _id: pending._id, business: f.business._id }, {
    $set: { 'cancellationIntent.nextAttemptAt': new Date(0), 'cancellationIntent.leaseUntil': new Date(0) },
  });
  await reconcileAppointmentCancellations(f.cancel);
  expect((await Appointment.findById(pending._id)).status).toBe('canceled');
  expect(f.provider.cancelAppointment).toHaveBeenCalledTimes(2);
  expect(f.events.has('event')).toBe(false);
});
