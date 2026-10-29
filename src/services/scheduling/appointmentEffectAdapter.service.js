// Original nonblocking side effect. Dependency injection enables isolated testing.
export const createNonBlockingAppointmentSideEffect = ({safeConsole, InterventionService}) => async ({
  appointment,
  businessId,
  label,
  task,
}) => {
  try {
    return await task();
  } catch (error) {
    safeConsole.error(`Appointment ${label} side effect failed:`, {
      appointmentId: String(appointment?._id || ""),
      businessId: String(businessId || appointment?.business || ""),
      error: error.message,
    });

    try {
      await InterventionService.create({
        businessId: businessId || appointment?.business,
        leadId: appointment?.lead || null,
        conversationId: appointment?.conversation || null,
        appointmentId: appointment?._id || null,
        type: "integration_failure",
        title: "Appointment notification follow-up needed",
        message: `The appointment was saved, but CallBackIQ could not complete the ${label} notification task.`,
        priority: "medium",
        reason: error.message,
        recommendedAction:
          "Review the appointment and contact the customer manually if needed.",
        metadata: { operation: label },
        dedupeKey: `appointment_side_effect:${label}:${appointment?._id || "unknown"}`,
      });
    } catch {
      // Never let an alerting failure reverse a durable appointment change.
    }

    return null;
  }
};
