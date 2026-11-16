// Compatibility entry point. The transition layer owns persistence and fencing.
export { saveBookingTransition, applyBookingEvent, resetExpiredBookingTurn } from './requestBookingPersistence.service.js';
export { saveStateDocument as saveBookingDocument } from '../stateTransitions/documents.js';
