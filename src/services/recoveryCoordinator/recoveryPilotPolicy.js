/**
 * The opt-in tenant policy for staged recovery coordination.
 * No database or network dependencies: caller-visible behavior is unchanged.
 * Do not infer whether a tenant is piloted from a client-supplied claim.
 */
export const isPilotBusiness = businessId =>
  String(process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(String(businessId?._id || businessId || ''));
