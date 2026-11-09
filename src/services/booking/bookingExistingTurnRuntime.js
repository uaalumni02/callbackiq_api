import { handleExistingBookingTurn as runExistingBookingTurn } from "./existingBookingTurn.service.js";
import { bookingInquiryOperations } from "./bookingInquiryRuntime.js";
import { updateState } from "./bookingTurnState.repository.js";

export function handleExistingBookingTurn(context) {
  return runExistingBookingTurn({ ...context, formatSlot: bookingInquiryOperations.formatSlot, updateState });
}
