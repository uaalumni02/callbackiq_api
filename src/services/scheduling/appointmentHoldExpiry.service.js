// MeekCall safe extraction: exact original hold-expiry operations and ordering.
// Dependencies are explicit, so reconciliation can be tested without initializing the API.
export const createExpiredHoldReconciler = ({ Appointment, reconcileApprovalRequests, repairPendingAppointmentLifecycles, repairPendingAppointmentProjections, repairRescheduleReviews, reconcileAppointmentNoticeFailures, runApprovalSms }) => async (businessId = null) => {
    const query = {
      status: "held",
      heldExpiresAt: { $lte: new Date() },
      ...(businessId ? { business: businessId } : {}),
    };

    const result = await Appointment.updateMany(query, {
      $set: {
        status: "failed",
        activeSlotKey: null,
        slotClaimKeys: [],
        capacityLane: null,
        failureReason: "Appointment hold expired before confirmation.",
        "approvalRecovery.reconciled": false,
        "approvalRecovery.expiredAt": new Date(),
      },
    });
    await reconcileApprovalRequests({ businessId });
    await repairPendingAppointmentLifecycles({ businessId });
    await repairPendingAppointmentProjections({ businessId });
    await repairRescheduleReviews({ businessId });
    await reconcileAppointmentNoticeFailures({ businessId });
    await runApprovalSms();
    return result;
};
