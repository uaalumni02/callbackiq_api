// Exact extracted tenant-scoped lookup. Dependency injected to test not-found behavior.
export const createAppointmentLookup = ({ Appointment }) => async (businessId, appointmentId) => {
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: businessId,
  });

  if (!appointment) {
    const error = new Error("Appointment not found.");
    error.statusCode = 404;
    throw error;
  }

  return appointment;
};
