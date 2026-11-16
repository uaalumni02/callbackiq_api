// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/integrations/googleCalendarChangeReview.service.js:60 — updateMany; predicate and write options are owned here.
export function googleCalendarChangeReviewResolveReviewAlertsAlertUpdateMany({ Alert, appointmentId, businessId, resolution }) {
  return (Alert.updateMany(
    {
      business: businessId,
      appointment: appointmentId,
      type: "appointment_change_review",
      resolvedAt: null,
    },
    {
      $set: {
        status: "resolved",
        resolvedAt: new Date(),
        resolution,
      },
    },
  ));
}

// src/services/integrations/googleCalendarChangeReview.service.js:226 — findOneAndUpdate; predicate and write options are owned here.
export function googleCalendarChangeReviewApproveMoveAppointmentAtomicUpdate({ Appointment, appointment, business, capacityLane, change, endAt, getSlotClaimKeys, reviewedBy, startAt }) {
  return (Appointment.findOneAndUpdate(
        {
          _id: appointment._id,
          business: business._id,
          "pendingProviderChange.status": "pending_review",
          status: appointment.status,
          stateVersion: appointment.stateVersion ? appointment.stateVersion : { $in: [0, null] },
          ...(appointment.updatedAt ? { updatedAt: appointment.updatedAt } : {}),
          'rescheduleIntent.key': { $exists: false },
          'confirmationIntent.status': { $ne: 'pending_provider' },
        },
        {
          $set: {
            startAt,
            endAt,
            capacityLane,
            activeSlotKey: `${startAt.toISOString()}|${endAt.toISOString()}|lane:${capacityLane}`,
            slotClaimKeys: getSlotClaimKeys({
              startAt,
              endAt,
              bufferBeforeMinutes: appointment.bufferBeforeMinutes,
              bufferAfterMinutes: appointment.bufferAfterMinutes,
              capacityLane,
            }),
            externalAppointmentId: change.eventId,
            externalCalendarId: change.calendarId,
            provider: "google_calendar",
            "pendingProviderChange.status": "approved",
            "pendingProviderChange.reviewedAt": new Date(),
            "pendingProviderChange.reviewedBy": reviewedBy || null,
          },
        },
        { returnDocument: "after", runValidators: true },
      ));
}

// src/services/integrations/googleCalendarChangeReview.service.js:286 — assignment; predicate and write options are owned here.
export function googleCalendarChangeReviewApproveCancelAppointmentFields({ appointment }) {
  return (appointment.status = "canceled");
}

// src/services/integrations/googleCalendarChangeReview.service.js:291 — assignment; predicate and write options are owned here.
export function googleCalendarChangeReviewApproveCancelAppointmentFields2({ appointment }) {
  return (appointment.pendingProviderChange.status = "approved");
}

// src/services/integrations/googleCalendarChangeReview.service.js:376 — assignment; predicate and write options are owned here.
export function googleCalendarChangeReviewRejectGoogleProviderChangeAppointmentFields({ appointment }) {
  return (appointment.pendingProviderChange.status = "rejected");
}
