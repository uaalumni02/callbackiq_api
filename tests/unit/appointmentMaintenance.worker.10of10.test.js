import { reconcileAppointmentCancellations } from '../../src/services/scheduling/appointmentCancellationRecovery.service.js';
jest.mock('../../src/services/scheduling/appointmentCancellationRecovery.service.js', () => ({ reconcileAppointmentCancellations: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/scheduling/rescheduleCompensationRepair.service.js', () => ({ repairRescheduleCompensations: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: {
    releaseExpiredHolds: jest.fn(),
    reconcileConfirmations: jest.fn(),
  },
}));

import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import {
  runAppointmentMaintenanceOnce,
  stopAppointmentMaintenanceWorker,
} from "../../src/workers/appointmentMaintenance.worker.js";

afterEach(() => {
  jest.clearAllMocks();
  stopAppointmentMaintenanceWorker();
});

test("appointment maintenance moves expired-hold writes out of GET traffic", async () => {
  AppointmentService.releaseExpiredHolds.mockResolvedValue({
    matchedCount: 3,
    modifiedCount: 2,
  });

  await expect(runAppointmentMaintenanceOnce()).resolves.toEqual({
    skipped: false,
    matched: 3,
    modified: 2,
  });
  expect(AppointmentService.reconcileConfirmations).toHaveBeenCalledWith();
  expect(AppointmentService.releaseExpiredHolds).toHaveBeenCalledWith();
  expect(reconcileAppointmentCancellations).toHaveBeenCalledWith(expect.any(Function));
});
