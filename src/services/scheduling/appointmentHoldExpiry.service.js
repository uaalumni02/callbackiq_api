import { expireUnclaimedHolds } from '../stateTransitions/appointmentLifecycle.js';
// MeekCall safe extraction: exact original hold-expiry operations and ordering.
// Dependencies are explicit, so reconciliation can be tested without initializing the API.
export const createExpiredHoldReconciler = ({ Appointment, reconcileApprovalRequests, repairPendingAppointmentLifecycles, repairPendingAppointmentProjections, repairRescheduleReviews, reconcileAppointmentNoticeFailures, runApprovalSms }) => async (businessId = null) => {
    const query = {
      status: "held",
      "confirmationIntent.status": { $ne: "pending_provider" },
      heldExpiresAt: { $lte: new Date() },
      ...(businessId ? { business: businessId } : {}),
    };
    const result = await expireUnclaimedHolds({ Appointment, query });
    await reconcileApprovalRequests({ businessId });
    await repairPendingAppointmentLifecycles({ businessId });
    await repairPendingAppointmentProjections({ businessId });
    await repairRescheduleReviews({ businessId });
    await reconcileAppointmentNoticeFailures({ businessId });
    await runApprovalSms();
    return result;
};
