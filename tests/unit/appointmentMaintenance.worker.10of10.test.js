jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: {
    releaseExpiredHolds: jest.fn(),
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
  expect(AppointmentService.releaseExpiredHolds).toHaveBeenCalledWith();
});
