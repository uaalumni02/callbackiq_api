import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();

// Server-only capability. Never read this from an AI tool or public availability
// payload. The authenticated intake approval service validates the opt-in.
export const withStaffSchedulingException = (exception, operation) => scope.run(Object.freeze({ ...exception }), operation);
export function currentStaffSchedulingException({ businessId, serviceOfferingId, startAt }) {
  const value = scope.getStore();
  if (!value || String(value.businessId) !== String(businessId) ||
      String(value.serviceOfferingId) !== String(serviceOfferingId) ||
      Date.parse(value.startAt) !== new Date(startAt).getTime()) return null;
  return value;
}
