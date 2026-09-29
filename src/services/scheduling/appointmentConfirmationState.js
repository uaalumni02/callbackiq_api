export const needsSeparateConfirmation = appointment => Boolean(
  appointment.requiresBusinessApproval || (appointment.automaticConfirmationAuthorized && appointment.source !== 'sms'),
);
export function confirmationNoticeState(appointment, job, receipt) {
  return { status: job?.status || (appointment?.status === 'confirmed' && needsSeparateConfirmation(appointment) ? 'missing' : 'not_scheduled'),
    deliveryStatus: receipt?.deliveryUncertain ? 'uncertain' : receipt?.deliveryStatus || receipt?.status || 'unverified',
    sentAt: job?.sentAt || null, failureReason: job?.failureReason || '' };
}
