// Exact extracted tenant-scoped lookup. Dependency injected to test not-found behavior.
export const createAppointmentLookup = ({ Appointment }) => async (businessId, appointmentId) => {
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: businessId,
  }, "+confirmationIntent");

  if (!appointment) {
    const error = new Error("Appointment not found.");
    error.statusCode = 404;
    throw error;
  }

  return appointment;
};

export function listAppointments({ Appointment, populateAppointment, businessId, query = {} }) {
    const filter = { business: businessId };
    if (query.status) filter.status = query.status;
    if (query.leadId) filter.lead = query.leadId;
    if (query.conversationId) filter.conversation = query.conversationId;
    if (query.startDate || query.endDate) {
      filter.startAt = {};
      if (query.startDate) filter.startAt.$gte = new Date(query.startDate);
      if (query.endDate) filter.startAt.$lte = new Date(query.endDate);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const skip = Math.max(Number(query.skip) || 0, 0);

    return populateAppointment(
      Appointment.find(filter).sort({ startAt: 1 }).skip(skip).limit(limit),
    );
}
