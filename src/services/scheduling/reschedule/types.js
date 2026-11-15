/** @typedef {string|import('mongoose').Types.ObjectId} Identity */
/** @typedef {{_id:Identity, timezone?:string, businessName?:string}} BusinessScope */
/** @typedef {{street?:string, city?:string, state?:string, postalCode?:string}} Address */
/** @typedef {{_id:Identity, durationMinutes:number}} Service */
/**
 * The document capabilities and state used by rescheduling; session/validation
 * remain owned by the hydrated document and its save implementation.
 * @typedef {object} AppointmentRecord
 * @property {Identity} _id
 * @property {Identity} business
 * @property {Identity|null} [lead]
 * @property {Identity|null} [conversation]
 * @property {Identity} serviceOffering
 * @property {string} status
 * @property {Date|string} startAt
 * @property {Date|string} endAt
 * @property {Address} [address]
 * @property {Identity|null} [rescheduledFrom]
 * @property {Identity|null} [rescheduledTo]
 * @property {string|null} [externalAppointmentId]
 * @property {string|null} [externalCalendarId]
 * @property {string|null} [pendingRescheduleExternalAppointmentId]
 * @property {string|null} [pendingRescheduleExternalCalendarId]
 * @property {string} [provider]
 * @property {Date|null} [confirmedAt]
 * @property {Date|null} [heldExpiresAt]
 * @property {object} [$where]
 * @property {()=>Promise<unknown>} save
 */
/** @typedef {{provider:string, externalAppointmentId:string|null, externalCalendarId:string|null}} ProviderReceipt */
/** @typedef {{applied:true, resumed:boolean, receipt:ProviderReceipt}} HandoffResult */
/** @typedef {{startAt:Date|string, endAt?:Date|string, address?:Address, requestId?:string, idempotencyKey?:string}} RescheduleInput */
/** @typedef {{business:BusinessScope, appointmentId:Identity, input:RescheduleInput, idempotencyKey?:string}} RescheduleRequest */
export {};
