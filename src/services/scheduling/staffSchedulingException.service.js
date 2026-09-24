import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();

// Server-only capability. Never read this from an AI tool or public availability
// payload. The authenticated intake approval service validates the opt-in.
export const withStaffSchedulingException = (exception, operation) => scope.run(Object.freeze({ ...exception }), operation);
export function currentStaffSchedulingException({ businessId, serviceOfferingId, startAt }) {
  const value = scope.getStore();
  if (!value || String(value.businessId) !== String(businessId) ||
      String(value.serviceOfferingId) !== String(serviceOfferingId) ||
      (value.preview !== true && Date.parse(value.startAt) !== new Date(startAt).getTime())) return null;
  return value;
}

export async function runStaffSchedulingRequest({ business, userId, input, preview = false }, operation) {
  const request = input?.schedulingException;
  if (!request) return operation();
  if (!userId || request.allowShortNotice !== true || typeof request.reason !== 'string' || request.reason.trim().length < 15 || request.reason.trim().length > 500) {
    throw Object.assign(new Error('Enter a 15–500 character reason for the short-notice exception.'), { statusCode: 400 });
  }
  return withStaffSchedulingException({ businessId: String(business._id), serviceOfferingId: String(input.serviceOfferingId),
    startAt: input.startAt, preview, approvedBy: String(userId), approvedAt: new Date(), reason: request.reason.trim() }, operation);
}
