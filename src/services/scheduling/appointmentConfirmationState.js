export const needsSeparateConfirmation = appointment => Boolean(
  appointment.requiresBusinessApproval || (appointment.automaticConfirmationAuthorized && appointment.source !== 'sms'),
);
export function confirmationNoticeState(appointment, job, receipt) {
  return { kind: appointment.lifecycleNotice?.key || 'confirmation', status: job?.status || (appointment.lifecycleNotice?.key ? 'missing' : (appointment?.status === 'confirmed' && needsSeparateConfirmation(appointment) ? 'missing' : 'not_scheduled')),
    deliveryStatus: receipt?.deliveryUncertain ? 'uncertain' : receipt?.deliveryStatus || receipt?.status || job?.deliveryStatus || 'unverified',
    sentAt: job?.sentAt || null, failureReason: job?.failureReason || '' };
}
