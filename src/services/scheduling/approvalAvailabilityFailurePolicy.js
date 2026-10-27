/**
 * Retain a still-pending staff-approval hold when a last-moment availability
 * check loses its slot. The existing hold-expiry maintenance and approval
 * reconciliation will release it and keep the customer request reviewable.
 *
 * No new writes, messages, provider calls, or booking permissions are added.
 */
export const preservePendingApprovalOnAvailabilityConflict = appointment =>
  appointment?.status === 'held' &&
  appointment?.requiresBusinessApproval === true &&
  appointment?.approvalDecisionAt == null;
