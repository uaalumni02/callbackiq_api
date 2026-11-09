import { handleExistingBookingTurn } from "./existingBookingTurn.service.js";
import { applyBookingStateFields } from "./requestBookingState.js";
import { createBookingInquiryOperations } from './inquiry/bookingInquiryOperations.js';
import { fixedResult } from './bookingFixedResult.policy.js';
import { createBookingTurnContext, isBookingTurnBlocked, planRejectedBookingPreference } from './bookingTurnDecision.policy.js';
import { mergeBookingClassification } from './bookingClassification.policy.js';
import { findBookingConversation } from './bookingConversation.repository.js';
import {BOOKING_INTENT,hasBookingAvailabilityHint,HUMAN_INTENT,EXACT_PRICE,ZIP_PATTERN,isAffirmative,isNegative} from './bookingMessagePolicy.service.js';
import { spreadSlotOptions, selectSlotOptions, selectOfferedSlot } from "./offeredSlotSelection.service.js";
export { selectOfferedSlot };
import { submitRescheduleRequest } from '../scheduling/rescheduleRequest.service.js';
import { schedulingEvidence } from './schedulingEvidence.service.js';
import { customerAppointmentLabel, renderAppointmentResponse } from '../scheduling/customerAppointmentPresentation.service.js';
import { handleConversationControl } from '../conversationControl.service.js';
import { extractCustomerAddress, resolveRequestAddress, normalizeSpokenAddress, extractCustomerPostalCode, withoutCustomerPostalCode } from './customerAddress.service.js';
import { getApprovedServiceEstimate } from './approvedServiceEstimate.service.js';
import { guardServiceRequest } from '../serviceEligibility/serviceEligibility.service.js';
import { requestStaffSchedulingReview } from "./staffSchedulingReview.service.js";
import { schedulingQuestionReply } from "./schedulingQuestions.service.js";
import { bookingQuestionReply } from "./conversationQuestions.service.js";
import { classifySmsIntent } from "../messaging/smsIntentClassifier.service.js";
import Appointment from "../../models/appointment.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import ServiceOffering from "../../models/serviceOffering.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import AlertService from "../alert.service.js";
import { buildBusinessReadiness } from "../businessReadiness.service.js";
import { logOperationalError, logOperationalEvent } from "../../helpers/logging/safeLogger.js";
import { formatDateKey } from "../scheduling/timezone.service.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { filterAutomatedSlots, automatedSchedulingNotice } from '../scheduling/automatedSchedulingPolicy.service.js';
import createAppointmentTool from "../../helpers/ai/tools/createAppointment.tool.js";
import escalateToHumanTool from "../../helpers/ai/tools/escalateToHuman.tool.js";
import getAvailabilityTool from "../../helpers/ai/tools/getAvailability.tool.js";
import rescheduleAppointmentTool from "../../helpers/ai/tools/rescheduleAppointment.tool.js";
import searchServicesTool from "../../helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../../helpers/ai/tools/validateServiceArea.tool.js";
import {
  filterSlotsByTimePreference,
  findDateRange,
  hasAppointmentPreferenceHint,
  parseTimePreference,
  rankSlotsByTimePreference,
} from "./appointmentPreferenceParser.service.js";













// CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: calendar/provider failure is never represented as zero availability.




const updateState = async (conversation, changes) => {
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
  applyBookingStateFields(conversation, changes);
  await conversation.save();
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
};


const { cleanStreetAddress, parseStreetAddress, buildAvailabilityPricingNote, formatSlot, handleReadOnlyAvailabilityInquiry, handleAvailabilityProviderFailure, handleBookingReadinessFailure } = createBookingInquiryOperations({ AlertService, assertDistributedLeaseActive, assertVoiceTurnActive, automatedSchedulingNotice, classifySmsIntent, customerAppointmentLabel, extractCustomerAddress, extractCustomerPostalCode, filterAutomatedSlots, filterSlotsByTimePreference, findDateRange, fixedResult, formatDateKey, getApprovedServiceEstimate, getAvailabilityTool, hasAppointmentPreferenceHint, logOperationalError, logOperationalEvent, parseTimePreference, rankSlotsByTimePreference, requestStaffSchedulingReview, searchServicesTool, selectSlotOptions, updateState, withoutCustomerPostalCode });

class BookingStateMachineService {
  static async findConversation({ business, lead, conversation }) {
    return findBookingConversation({ business, lead, conversation });
  }

  static async handle(parameters) {
    const classification = classifySmsIntent(parameters);
    const outcome = await this.handleTurn(parameters);
    return mergeBookingClassification({ parameters, classification, outcome });
  }

  static async handleTurn({
    business,
    lead,
    conversation,
    customerMessage,
    channel = "sms",
    source = "booking_state_machine",
  }) {
    const { bookingChannel, bookingSource, bookingIdempotencyPrefix, bookingEventPrefix, enabled, text } =
      createBookingTurnContext({ business, customerMessage, channel, source });
    if (isBookingTurnBlocked(conversation)) return { handled: false };

    const control = await handleConversationControl({ business, lead, conversation, customerMessage, channel });
    if (control) return { handled: true, result: control };
    const serviceGuard = await guardServiceRequest({ business, lead, conversation, customerMessage, channel });
    if (serviceGuard) return { handled: true, result: serviceGuard };
    const schedulingReply = schedulingQuestionReply({ customerMessage: text, business, lead });
    if (schedulingReply) return { handled: true, result: fixedResult({ reply: schedulingReply, category: "availability_inquiry" }) };

    const questionReply = bookingQuestionReply({ customerMessage: text, conversation, lead, channel });
    if (questionReply) return { handled: true, result: fixedResult({ reply: questionReply, category: "appointment_status" }) };

    const evidence = schedulingEvidence(text);
    const timezone = business.timezone || 'America/New_York';
    const acceptedTime = parseTimePreference(text, timezone);
    const preferenceRejection = planRejectedBookingPreference({
      evidence, acceptedTime, hasReplacementDate: evidence.rejectedDate ? Boolean(findDateRange(text, timezone)) : false,
      enabled, hasExistingAppointment: Boolean(conversation?.bookingState?.appointment),
    });
    if (preferenceRejection) {
      // Rejected proposals must not remain selectable on the next "yes".
      if (lead?.save && preferenceRejection.updateRequestedPreference) {
        const range = evidence.rejectedDate ? findDateRange(text, timezone) : findDateRange(lead.preferredAppointmentTime, timezone);
        const time = evidence.rejectedTime ? acceptedTime : parseTimePreference(lead.preferredAppointmentTime, timezone);
        const day = range ? range.startDate === range.endDate ? range.startDate : `${range.startDate} through ${range.endDate}` : '';
        const clock = time.exactMinutes !== null ? `${Math.floor(time.exactMinutes / 60)}:${String(time.exactMinutes % 60).padStart(2, '0')}`
          : time.targetMinutes !== null || time.timeOfDay ? time.raw : '';
        assertVoiceTurnActive(); assertDistributedLeaseActive();
        lead.preferredAppointmentTime = [day, clock].filter(Boolean).join(' at ');
        await lead.save();
      }
      if (conversation?.set && preferenceRejection.updateRequestedPreference) {
        await updateState(conversation, preferenceRejection.statePatch);
      }
      return { handled: true, result: fixedResult({
        reply: preferenceRejection.reply, category: preferenceRejection.category,
      }) };
    }

    if (!enabled) {
      const smsIntent = classifySmsIntent({
        customerMessage: text,
        business,
        conversation,
      });

      const readOnlySlots = conversation?.bookingState?.offeredSlots || [];
      if (
        conversation?.bookingState?.status === "offering_slots" &&
        readOnlySlots.length
      ) {
        const expired = conversation.bookingState.expiresAt && new Date(conversation.bookingState.expiresAt) <= new Date();
        if (expired) {
          await updateState(conversation, { offeredSlots: [], selectedSlot: null, status: 'not_started', expiresAt: null });
          const refreshed = await handleReadOnlyAvailabilityInquiry({ business, lead, conversation, channel: bookingChannel, text: 'What is available?' });
          refreshed.result.reply = `The earlier options expired. ${refreshed.result.reply}`;
          return refreshed;
        }
        const selected = selectOfferedSlot(
          text,
          filterAutomatedSlots(readOnlySlots),
          business.timezone || "America/New_York",
        );

        if (!selected) {
          if (smsIntent.intents.availabilityInquiry || smsIntent.intents.scheduling) {
            return handleReadOnlyAvailabilityInquiry({
              channel: bookingChannel,
              business,
              lead,
              conversation,
              text,
            });
          }
          if (!/^\s*(?:option\s*)?\d+\s*[.!]?\s*$/i.test(text)) return { handled: false };
          return {
            handled: true,
            result: fixedResult({
              reply:
                "Please choose one of the available option numbers, or ask me to check another day.",
              category: "availability_inquiry",
            }),
          };
        }

        const selectedLabel = formatSlot(
          selected,
          business.timezone || "America/New_York",
        );
        if (lead) {
          assertVoiceTurnActive(); assertDistributedLeaseActive();
          lead.preferredAppointmentTime = selectedLabel;
          await lead.save();
        }

        assertVoiceTurnActive(); assertDistributedLeaseActive();
        const savedSelection = await AlertService.create({
          businessId: business._id, leadId: lead?._id, conversationId: conversation?._id,
          type: "system", actionRequired: true,
          recommendedAction: "Check the service address, service area and timing, then accept or decline the requested visit.",
          title: "Customer selected an appointment time",
          message:
            "Automatic booking is disabled, but the customer selected a real available slot. The team must confirm the appointment directly.",
          priority: ["high", "emergency"].includes(String(lead?.urgency || ""))
            ? "high"
            : "medium",
          metadata: {
            leadId: lead?._id ? String(lead._id) : "",
            conversationId: conversation?._id ? String(conversation._id) : "",
            selectedStartAt: selected.startAt,
            selectedEndAt: selected.endAt,
            channel: bookingChannel,
          },
          dedupeKey: `read_only_slot_selected:${business._id}:${conversation?._id || lead?._id || "unknown"}:${new Date(selected.startAt).toISOString()}`,
        });

        if (!savedSelection?.alert?._id) throw Object.assign(new Error("Selected time was not queued for review."), { code: "STAFF_ACTION_NOT_SAVED" });
        if (conversation?.set && typeof conversation.save === "function") {
          await updateState(conversation, {
            status: "human_takeover",
            selectedSlot: selected,
            availabilityInquiry: false,
            escalatedAt: new Date(),
            offeredSlots: [],
            expiresAt: null,
            lastError: "selected_slot_requires_manual_confirmation",
          });
        }

        return {
          handled: true,
          result: fixedResult({
            reply: `I’ve sent your request for ${selectedLabel} to ${business.businessName || "the business"}. That appointment is not confirmed until the team accepts it.${!lead?.address ? " I still need the service address to complete the request." : ""}`,
            category: "appointment_preference",
          }),
        };
      }

      if (smsIntent.intents.availabilityInquiry || (smsIntent.intents.scheduling && conversation?.bookingState?.searchStartDate)) {
        return handleReadOnlyAvailabilityInquiry({
              channel: bookingChannel,
          business,
          lead,
          conversation,
          text,
        });
      }

      return { handled: false };
    }

    const activeConversation = await this.findConversation({
      business,
      lead,
      conversation,
    });

    if (!activeConversation || activeConversation.humanTakeover) {
      return { handled: false };
    }

    const smsIntent = classifySmsIntent({
      customerMessage: text,
      business,
      conversation: activeConversation,
    });
    const currentStatus =
      activeConversation.bookingState?.status || "not_started";
    const stateActive = currentStatus !== "not_started";

    if (
      !stateActive &&
      bookingChannel !== "voice" &&
      !smsIntent.intents.scheduling &&
      !hasBookingAvailabilityHint(text, business.timezone || "America/New_York")
    ) {
      return { handled: false };
    }

    if (smsIntent.intents.human) {
      await escalateToHumanTool({
        businessId: business._id,
        leadId: lead?._id,
        conversationId: activeConversation._id,
        reason: "customer_requested_human",
        customerMessage: text,
      });

      return {
        handled: true,
        result: fixedResult({
          reply:
            "I’ve paused the automated booking and alerted the team. A person will follow up directly.",
          category: "human_requested",
        }),
      };
    }

    if (
      smsIntent.intents.pricing &&
      !smsIntent.intents.availabilityInquiry
    ) {
      const approvedEstimate = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead?.serviceNeeded, customerMessage: text });

      return {
        handled: true,
        result: fixedResult({
          reply:
            approvedEstimate ||
            (EXACT_PRICE.test(text)
              ? "I can help schedule the visit, but the team must confirm final scope and pricing after reviewing the job."
              : "I don’t have a business-approved price range for that service, so I don’t want to guess. I can still help schedule a visit so the team can assess the job and confirm pricing."),
          category: "pricing_request",
        }),
      };
    }

    // CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: feature flag alone is insufficient; booking must be operationally ready now.
    let runtimeReadiness;
    try {
      runtimeReadiness = await buildBusinessReadiness(business, {
        persist: false,
      });
    } catch (error) {
      return handleBookingReadinessFailure({
        business,
        lead,
        conversation: activeConversation,
        error,
        customerMessage: text,
      });
    }

    if (!runtimeReadiness?.states?.bookingReady) {
      return handleBookingReadinessFailure({
        business,
        lead,
        conversation: activeConversation,
        readiness: runtimeReadiness,
        customerMessage: text,
      });
    }

    let status = currentStatus;
    const offerExpired = Boolean(
      activeConversation.bookingState?.status !== 'pending_business_confirmation' && activeConversation.bookingState?.expiresAt &&
        activeConversation.bookingState.expiresAt < new Date(),
    );

    if (status === "failed" || offerExpired) {
      await updateState(activeConversation, {
        status: "collecting_service",
        offeredSlots: [],
        selectedSlot: null,
        negotiationAttempts: 0,
        lastCustomerPreference: text,
        lastAvailabilityCheckedAt: new Date(),
        expiresAt: null,
        lastError: "",
      });
      status = "collecting_service";

      // The customer's reply belongs to the stale offer. Return after the
      // reset so words such as "first" are not treated as a new service.
      if (offerExpired) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "That appointment offer expired. What service would you like to schedule?",
          }),
        };
      }
    }

    if (status === "not_started" || status === "collecting_service") {
      const serviceQuery =
        (smsIntent.intents.availabilityInquiry ||
          hasBookingAvailabilityHint(
            text,
            business.timezone || "America/New_York",
          )) &&
        String(lead?.serviceNeeded || "").trim() &&
        lead.serviceNeeded !== "Unknown"
          ? lead.serviceNeeded
          : text;
      const matches = await searchServicesTool({
        businessId: business._id,
        query: serviceQuery,
      });

      if (matches.length !== 1) {
        await updateState(activeConversation, {
          status: "collecting_service",
        });
        const choices = matches.length
          ? ` I found: ${matches.map((item) => item.name).join(", ")}.`
          : "";

        return {
          handled: true,
          result: fixedResult({
            reply: smsIntent.entities.serviceNeeded || (lead?.serviceNeeded && lead.serviceNeeded !== "Unknown")
            ? `I want to make sure we arrange the right visit.${choices} ${matches.length ? "Which of these best describes the visit you need?" : "What type of equipment or fixture needs service?"}`
            : `What service would you like to schedule?${choices}`,
          }),
        };
      }

      const selectedService = matches[0];
      await updateState(activeConversation, {
        status: "collecting_location",
        serviceOffering: selectedService.id,
        ...(() => {
          const address = resolveRequestAddress({ customerMessage: text, lead, conversation: activeConversation });
          return { streetAddress: cleanStreetAddress(address), postalCode: extractCustomerPostalCode(address) };
        })(),
        availabilityInquiry: smsIntent.intents.availabilityInquiry,
      });

      const compoundPricingNote = await buildAvailabilityPricingNote({
        business,
        bookingState: activeConversation.bookingState,
        lead,
        text,
      });

      if (lead && (!lead.serviceNeeded || lead.serviceNeeded === "Unknown")) {
        lead.serviceNeeded = smsIntent.entities.serviceNeeded || selectedService.name;
        await lead.save();
      }

      if (!activeConversation.bookingState?.streetAddress) return {
        handled: true,
        result: fixedResult({
          reply: `${compoundPricingNote ? `${compoundPricingNote} ` : ""}I can check times for ${selectedService.name}. What’s the street address for the visit, including the ZIP code?`,
        }),
      };
      status = "collecting_location";
    }

    if (
      status === "collecting_street_address" ||
      status === "collecting_location"
    ) {
      const address = resolveRequestAddress({ customerMessage: text, lead, conversation: activeConversation });
      const { street, valid } = parseStreetAddress(address);
      const suppliedZip = extractCustomerPostalCode(address);

      if (!valid) {
        await updateState(activeConversation, {
          status: "collecting_street_address",
          ...(suppliedZip ? { postalCode: suppliedZip } : {}),
        });
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please send the street address, including the street number and street name—for example, 125 Main Street.",
          }),
        };
      }

      if (lead) {
        lead.address = address;
        await lead.save();
      }

      if (!suppliedZip) {
        await updateState(activeConversation, {
          status: "collecting_postal_code",
          streetAddress: street,
        });
        return {
          handled: true,
          result: fixedResult({
            reply: "Thanks. What is the 5-digit ZIP code for that address?",
          }),
        };
      }

      const area = await validateServiceAreaTool({
        businessId: business._id,
        postalCode: suppliedZip,
      });
      if (area.supported !== true) {
        await escalateToHumanTool({
          businessId: business._id,
          leadId: lead?._id,
          conversationId: activeConversation._id,
          reason: area.supported === false ? "unsupported_service_area" : "service_area_review_required",
          customerMessage: text,
        });
        return {
          handled: true,
          result: fixedResult({
            reply:
              area.supported === false
                ? "That ZIP code is outside the area this team normally serves. The team needs to review this location before scheduling."
                : "I couldn't verify coverage for that address. The team needs to review this location before scheduling.",
            category: "service_area_question",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "collecting_preference",
        streetAddress: street,
        postalCode: suppliedZip,
      });

      if (activeConversation.bookingState?.availabilityInquiry) {
        return this.handle({
          business,
          lead,
          conversation: activeConversation,
          customerMessage: "earliest availability",
          channel: bookingChannel,
          source: bookingSource,
        });
      }

      // Shared intake may already have collected the location before this
      // booking turn. Consume a date/time supplied now instead of asking again.
      if (hasBookingAvailabilityHint(text, business.timezone || "America/New_York")) {
        status = "collecting_preference";
      } else {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "What day and time work best? You can text naturally—for example: tomorrow at 2, day after tomorrow around 3ish, Friday morning, Aug 10 at 2:30, or after work.",
          }),
        };
      }
    }

    if (status === "collecting_postal_code") {
      const address = resolveRequestAddress({ customerMessage: text, lead, conversation: activeConversation });
      const zip = extractCustomerPostalCode(address) || extractCustomerPostalCode(normalizeSpokenAddress(text));
      if (!zip) {
        return {
          handled: true,
          result: fixedResult({
            reply: "Please send the 5-digit ZIP code for the service address.",
          }),
        };
      }

      const area = await validateServiceAreaTool({
        businessId: business._id,
        postalCode: zip,
      });
      if (area.supported !== true) {
        await escalateToHumanTool({
          businessId: business._id,
          leadId: lead?._id,
          conversationId: activeConversation._id,
          reason: area.supported === false ? "unsupported_service_area" : "service_area_review_required",
          customerMessage: text,
        });
        return {
          handled: true,
          result: fixedResult({
            reply:
              area.supported === false
                ? "That ZIP code is outside the area this team normally serves. The team needs to review this location before scheduling."
                : "I couldn't verify coverage for that address. The team needs to review this location before scheduling.",
            category: "service_area_question",
          }),
        };
      }

      if (lead && address) {
        lead.address = extractCustomerPostalCode(address) ? address : `${address}, ${zip}`;
        await lead.save();
      }
      await updateState(activeConversation, {
        status: "collecting_preference",
        ...(address ? { streetAddress: cleanStreetAddress(address) } : {}),
        postalCode: zip,
      });

      if (activeConversation.bookingState?.availabilityInquiry) {
        return this.handle({
          business,
          lead,
          conversation: activeConversation,
          customerMessage: "earliest availability",
          channel: bookingChannel,
          source: bookingSource,
        });
      }

      // Shared intake may already have collected the location before this
      // booking turn. Consume a date/time supplied now instead of asking again.
      if (hasBookingAvailabilityHint(text, business.timezone || "America/New_York")) {
        status = "collecting_preference";
      } else {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "What day and time work best? You can text naturally—for example: tomorrow at 2, day after tomorrow around 3ish, Friday morning, Aug 10 at 2:30, or after work.",
          }),
        };
      }
    }

    if (status === "collecting_preference") {
      const timeZone = business.timezone || "America/New_York";
      const availabilityInquiry = Boolean(
        smsIntent.intents.availabilityInquiry ||
          activeConversation.bookingState?.availabilityInquiry,
      );
      const requestedRange = findDateRange(text, timeZone);
      const today = formatDateKey(new Date(), timeZone);
      const previousRange = activeConversation.bookingState.searchStartDate && activeConversation.bookingState.searchEndDate
        ? { startDate: activeConversation.bookingState.searchStartDate, endDate: activeConversation.bookingState.searchEndDate }
        : findDateRange(lead?.preferredAppointmentTime || '', timeZone);
      const range =
        requestedRange || previousRange ||
        (availabilityInquiry
          ? {
              startDate: today,
              endDate: formatDateKey(
                new Date(Date.now() + 6 * 86_400_000),
                timeZone,
              ),
            }
          : null);
      const timePreference = parseTimePreference(text, timeZone);
      const timeOfDay = timePreference.timeOfDay;

      if (!range) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please send the day and time that work for you. You can say things like tomorrow at 2, day after next around 3ish, Friday morning, Aug 10, or after 5.",
          }),
        };
      }

      await updateState(activeConversation, { searchStartDate: range.startDate, searchEndDate: range.endDate });

      let availability;
      try {
        availability = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id,
          serviceOfferingId:
            activeConversation.bookingState.serviceOffering,
          startDate: range.startDate,
          endDate: range.endDate,
          postalCode: activeConversation.bookingState.postalCode,
        });
      } catch (error) {
        return handleAvailabilityProviderFailure({
          business,
          lead,
          conversation: activeConversation,
          error,
          customerMessage: text,
          code: "primary_availability_provider_failed",
        });
      }
      const matchingSlots = filterSlotsByTimePreference(
        filterAutomatedSlots(availability.slots),
        timePreference,
        timeZone,
      );
      const offeredSlots = selectSlotOptions(
        matchingSlots,
        lead?.urgency,
        3,
      );

      if (offeredSlots.length === 0 && range.startDate === today && range.endDate === today) {
        return { handled: true, result: await requestStaffSchedulingReview({ business, lead, conversation: activeConversation, customerMessage: text, channel: bookingChannel }) };
      }
      if (offeredSlots.length === 0) {
        const attempts = Number(activeConversation.bookingState?.negotiationAttempts || 0) + 1;
        const expandedRange = {
          startDate: range.startDate,
          endDate: formatDateKey(new Date(Date.now() + 14 * 86_400_000), timeZone),
        };
        let alternatives = [];
        try {
          const expanded = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id,
            serviceOfferingId: activeConversation.bookingState.serviceOffering,
            startDate: expandedRange.startDate,
            endDate: expandedRange.endDate,
            postalCode: activeConversation.bookingState.postalCode,
          });
          const expandedSlots = filterAutomatedSlots(expanded.slots);
          const expandedMatches = filterSlotsByTimePreference(
            expandedSlots,
            timePreference,
            timeZone,
          );
          alternatives = expandedMatches.length
            ? selectSlotOptions(expandedMatches, lead?.urgency, 3)
            : ["high", "emergency"].includes(
                  String(lead?.urgency || "").toLowerCase(),
                )
              ? selectSlotOptions(expandedSlots, lead?.urgency, 3)
              : timePreference.targetMinutes !== null
                ? rankSlotsByTimePreference(
                    expandedSlots,
                    timePreference,
                    timeZone,
                  ).slice(0, 3)
                : spreadSlotOptions(expandedSlots, 3);
        } catch (error) {
          return handleAvailabilityProviderFailure({
            business,
            lead,
            conversation: activeConversation,
            error,
            customerMessage: text,
            code: "expanded_availability_provider_failed",
          });
        }

        await updateState(activeConversation, {
          negotiationAttempts: attempts,
          lastCustomerPreference: text,
          lastAvailabilityCheckedAt: new Date(),
        });

        if (attempts >= 3 && alternatives.length === 0) {
          await escalateToHumanTool({
            businessId: business._id,
            leadId: lead?._id,
            conversationId: activeConversation._id,
            reason: "scheduling_no_match_after_three_attempts",
            customerMessage: text,
          });
          await updateState(activeConversation, {
            status: "human_takeover",
            escalatedAt: new Date(),
          });
          return {
            handled: true,
            result: fixedResult({
              reply: "I’m not finding a good calendar match yet, so I’ve sent your availability to the team. They’ll follow up to find the best time.",
              category: "human_requested",
            }),
          };
        }

        if (alternatives.length) {
          const options = alternatives
            .map((slot, index) => `${index + 1}) ${formatSlot(slot, timeZone)}`)
            .join("; ");
          await updateState(activeConversation, {
            status: "offering_slots",
            offeredSlots: alternatives.map((slot) => ({
              startAt: new Date(slot.startAt), endAt: new Date(slot.endAt), timezone: timeZone,
              label: formatSlot(slot, timeZone),
          arrivalStartAt: slot.arrivalStartAt, arrivalEndAt: slot.arrivalEndAt,
          requiresBusinessApproval: slot.requiresBusinessApproval !== false,
          selectionSubmits: true,
            })),
            expiresAt: new Date(Date.now() + 30 * 60_000),
          });
          return { handled: true, result: fixedResult({
            reply: `That time isn’t available. ${renderAppointmentResponse({ kind: 'offer', options: `I have ${options}`, requiresApproval: alternatives.some(slot => slot.requiresBusinessApproval !== false) }, bookingChannel)}`,
          }) };
        }

        return {
          handled: true,
          result: fixedResult({
            reply: timeOfDay
              ? `I don’t see an available ${timeOfDay} time in that window. What other day or time works for you?`
              : "I don’t see an available time in that window. What other day or time works for you?",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "offering_slots",
        timeOfDay,
        preferredStart: new Date(offeredSlots[0].startAt),
        preferredEnd: new Date(
          offeredSlots[offeredSlots.length - 1].endAt,
        ),
        offeredSlots: offeredSlots.map((slot) => ({
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          timezone: timeZone,
          label: formatSlot(slot, timeZone),
          arrivalStartAt: slot.arrivalStartAt, arrivalEndAt: slot.arrivalEndAt,
          requiresBusinessApproval: slot.requiresBusinessApproval !== false,
          selectionSubmits: true,
        })),
        selectedSlot: null,
        negotiationAttempts: 0,
        lastCustomerPreference: availabilityInquiry
          ? activeConversation.bookingState?.lastCustomerPreference || ""
          : text,
        lastAvailabilityCheckedAt: new Date(),
        availabilityInquiry: false,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });

      await ConversionEventService.record({
        businessId: business._id,
        leadId: lead?._id,
        conversationId: activeConversation._id,
        type: "appointment_offered",
        channel: bookingChannel,
        source: bookingSource,
        idempotencyKey: `${bookingEventPrefix}appointment_offered:${activeConversation._id}:${offeredSlots[0].startAt}`,
        metadata: { offeredSlots },
      });

      await AutomationTriggerService.schedule({
        businessId: business._id,
        trigger: "appointment_offered_not_selected",
        leadId: lead?._id,
        conversationId: activeConversation._id,
        triggerInstanceId: `${activeConversation._id}:${offeredSlots[0].startAt}`,
      });

      const options = offeredSlots
        .map(
          (slot, index) =>
            `${index + 1}) ${formatSlot(slot, timeZone)}`,
        )
        .join("; ");
      const compoundPricingNote = await buildAvailabilityPricingNote({
        business,
        bookingState: activeConversation.bookingState,
        lead,
        text,
      });

      return {
        handled: true,
        result: fixedResult({
          reply: `${compoundPricingNote ? `${compoundPricingNote} ` : ""}${renderAppointmentResponse({ kind: 'offer', options: `I have ${options}`, requiresApproval: offeredSlots.some(slot => slot.requiresBusinessApproval !== false) }, bookingChannel)}`,
        }),
      };
    }

    if (status === "offering_slots") {
      const slot = selectOfferedSlot(
        text,
        filterAutomatedSlots(activeConversation.bookingState.offeredSlots || []),
        business.timezone || "America/New_York",
      );

      if (!slot) {
        if (smsIntent.intents.availabilityInquiry || hasAppointmentPreferenceHint(text, business.timezone || "America/New_York")) {
          await updateState(activeConversation, {
            status: "collecting_preference",
          });
          return this.handle({
            business,
            lead,
            conversation: activeConversation,
            customerMessage: text,
            channel: bookingChannel,
            source: bookingSource,
          });
        }

        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please reply with the option number, or send another day.",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "awaiting_confirmation",
        selectedSlot: slot,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });

      if (bookingChannel === 'sms' && slot.selectionSubmits === true &&
          activeConversation.bookingState.streetAddress && activeConversation.bookingState.postalCode &&
          activeConversation.bookingState.lastError !== 'reschedule_requested' &&
          /^(?:option\s*)?[12]\s*[.!]?$/i.test(text)) {
        return this.handleTurn({ business, lead, conversation: activeConversation, customerMessage: 'YES', channel: bookingChannel, source: bookingSource });
      }
      const serviceName = lead?.serviceNeeded || "the requested service";
      const address = [
        activeConversation.bookingState.streetAddress || lead?.address,
        activeConversation.bookingState.postalCode,
      ]
        .filter(Boolean)
        .join(", ") || `ZIP ${activeConversation.bookingState.postalCode}`;

      return {
        handled: true,
        result: fixedResult({
          reply: renderAppointmentResponse({ kind: 'review', label: formatSlot(slot, business.timezone || 'America/New_York'), service: serviceName, address, requiresApproval: slot.requiresBusinessApproval !== false }, bookingChannel),
        }),
      };
    }

    if (status === "awaiting_confirmation") {
      if (smsIntent.response.negative) {
        await updateState(activeConversation, {
          status: "collecting_preference",
          selectedSlot: null,
          offeredSlots: [],
          expiresAt: null,
        });

        return {
          handled: true,
          result: fixedResult({
            reply: "No problem. What other day would you prefer?",
          }),
        };
      }

      if (!smsIntent.response.affirmative) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please reply CONFIRM to submit that exact time for business approval, or NO to choose another day.",
          }),
        };
      }

      const selectedSlot = activeConversation.bookingState.selectedSlot;
      assertVoiceTurnActive();
      await updateState(activeConversation, { status: "booking" });

      try {
        const bookingInput = {
          lead: lead?._id,
          conversation: activeConversation._id,
          serviceOfferingId:
            activeConversation.bookingState.serviceOffering,
          customerName:
            lead?.customerName || activeConversation.customerName,
          customerPhone:
            lead?.phone || activeConversation.customerPhone,
          customerEmail: lead?.email || "",
          address: {
            street:
              activeConversation.bookingState.streetAddress ||
              lead?.address ||
              "",
            postalCode: activeConversation.bookingState.postalCode,
          },
          startAt: selectedSlot.startAt,
          endAt: selectedSlot.endAt,
          timezone: business.timezone || "America/New_York",
          estimatedValue: lead?.estimatedValue ?? null,
          source: bookingChannel,
          bookedBy: "ai",
          urgency: lead?.urgency || "medium",
        };
        const isReschedule =
          activeConversation.bookingState.lastError ===
            "reschedule_requested" &&
          activeConversation.bookingState.appointment;
        assertVoiceTurnActive();
        if (isReschedule) {
          const requestedTime = formatSlot(
            selectedSlot,
            business.timezone || "America/New_York",
          );
          try {
            await submitRescheduleRequest({ business, appointmentId: activeConversation.bookingState.appointment,
              conversationId: activeConversation._id, startAt: selectedSlot.startAt, endAt: selectedSlot.endAt,
              channel: bookingChannel });
          } catch (error) {
            if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
            return { handled: true, result: fixedResult({ reply: 'I could not verify that your change request reached the team. Your existing appointment has not been changed. Please contact the business directly or try again.' }) };
          }

          await updateState(activeConversation, {
            status: "booked",
            selectedSlot: null,
            offeredSlots: [],
            expiresAt: null,
            lastError: "reschedule_pending_business_approval",
          });

          return {
            handled: true,
            result: fixedResult({
              reply: `I’ve submitted your request to move the appointment to ${requestedTime}. Your existing appointment remains confirmed until the business approves the change.`,
            }),
          };
        }

        const appointment = await createAppointmentTool({
          business,
          idempotencyKey: `${bookingIdempotencyPrefix}ai-book:${activeConversation._id}:${new Date(
            selectedSlot.startAt,
          ).toISOString()}`,
          input: bookingInput,
        });

        assertVoiceTurnActive();
        if (
          !(appointment.status === 'confirmed' && appointment.automaticConfirmationAuthorized === true) &&
          (appointment.status !== "held" || appointment.requiresBusinessApproval !== true)
        ) {
          const invariantError = new Error(
            "AI appointment creation bypassed the required business-approval hold.",
          );
          invariantError.code = "AI_BOOKING_APPROVAL_INVARIANT_VIOLATION";
          invariantError.safeCustomerMessage =
            "I couldn’t safely submit that appointment request. I’ve alerted the team so they can confirm a time directly.";
          throw invariantError;
        }

        if (appointment.status === 'confirmed' && appointment.automaticConfirmationAuthorized === true) {
          await updateState(activeConversation, { status: 'booked', appointment: appointment._id, expiresAt: null, lastError: '' });
          return { handled: true, result: fixedResult({ reply: renderAppointmentResponse({ kind: 'confirmed', label: formatSlot(appointment, appointment.timezone) }, bookingChannel) }) };
        }
        await updateState(activeConversation, {
          status: "pending_business_confirmation",
          appointment: appointment._id,
          expiresAt: appointment.heldExpiresAt || null,
          lastError: "",
        });

        return {
          handled: true,
          result: fixedResult({
            reply: renderAppointmentResponse({ kind: 'submitted', label: formatSlot(appointment, appointment.timezone) }, bookingChannel),
          }),
        };
      } catch (error) {
        await updateState(activeConversation, {
          status: "failed",
          lastError: error.message,
          expiresAt: null,
        });

        return {
          handled: true,
          result: fixedResult({
            reply:
              error.safeCustomerMessage ||
              "I’m having trouble confirming that appointment right now. I’ve sent your request to the team so they can confirm it directly.",
          }),
        };
      }
    }

    if (status === "pending_business_confirmation" || status === "booked") {
      return handleExistingBookingTurn({
        status, activeConversation, business, bookingChannel, text, formatSlot, updateState,
      });
    }

    return { handled: false };
  }
}

export default BookingStateMachineService;
