import AppointmentService from "../services/scheduling/appointment.service.js";

let timer = null;
let running = false;

const intervalMs = () =>
  Math.max(
    15_000,
    Number(process.env.APPOINTMENT_MAINTENANCE_INTERVAL_MS) || 60_000,
  );

export const runAppointmentMaintenanceOnce = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    const result = await AppointmentService.releaseExpiredHolds();
    return {
      skipped: false,
      matched: Number(result?.matchedCount || 0),
      modified: Number(result?.modifiedCount || 0),
    };
  } finally {
    running = false;
  }
};

export const startAppointmentMaintenanceWorker = () => {
  if (timer) return timer;

  void runAppointmentMaintenanceOnce().catch((error) => {
    console.error("Appointment maintenance failed:", error);
  });

  timer = setInterval(() => {
    void runAppointmentMaintenanceOnce().catch((error) => {
      console.error("Appointment maintenance failed:", error);
    });
  }, intervalMs());
  timer.unref?.();
  return timer;
};

export const stopAppointmentMaintenanceWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
};

export default {
  runAppointmentMaintenanceOnce,
  startAppointmentMaintenanceWorker,
  stopAppointmentMaintenanceWorker,
};
