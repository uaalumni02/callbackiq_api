import { createBookingInquiryOperations } from './inquiry/bookingInquiryOperations.js';
import { fixedResult } from './bookingFixedResult.policy.js';
import { selectSlotOptions } from "./offeredSlotSelection.service.js";
import { customerAppointmentLabel } from '../scheduling/customerAppointmentPresentation.service.js';
import { extractCustomerAddress, extractCustomerPostalCode, withoutCustomerPostalCode } from './customerAddress.service.js';
import { getApprovedServiceEstimate } from './approvedServiceEstimate.service.js';
import { requestStaffSchedulingReview } from "./staffSchedulingReview.service.js";
import { classifySmsIntent } from "../messaging/smsIntentClassifier.service.js";
import AlertService from "../alert.service.js";
import { logOperationalError, logOperationalEvent } from "../../helpers/logging/safeLogger.js";
import { formatDateKey } from "../scheduling/timezone.service.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { filterAutomatedSlots, automatedSchedulingNotice } from '../scheduling/automatedSchedulingPolicy.service.js';
import getAvailabilityTool from "../../helpers/ai/tools/getAvailability.tool.js";
import searchServicesTool from "../../helpers/ai/tools/searchServices.tool.js";
import {
  filterSlotsByTimePreference,
  findDateRange,
  hasAppointmentPreferenceHint,
  parseTimePreference,
  rankSlotsByTimePreference,
} from "./appointmentPreferenceParser.service.js";
import { saveBookingTransition } from "./bookingTurnState.repository.js";

export const bookingInquiryOperations = createBookingInquiryOperations({
  AlertService,
  assertDistributedLeaseActive,
  assertVoiceTurnActive,
  automatedSchedulingNotice,
  classifySmsIntent,
  customerAppointmentLabel,
  extractCustomerAddress,
  extractCustomerPostalCode,
  filterAutomatedSlots,
  filterSlotsByTimePreference,
  findDateRange,
  fixedResult,
  formatDateKey,
  getApprovedServiceEstimate,
  getAvailabilityTool,
  hasAppointmentPreferenceHint,
  logOperationalError,
  logOperationalEvent,
  parseTimePreference,
  rankSlotsByTimePreference,
  requestStaffSchedulingReview,
  searchServicesTool,
  selectSlotOptions,
  saveBookingTransition,
  withoutCustomerPostalCode,
});
