import { fixedResult } from './bookingFixedResult.policy.js';
import { hasBookingAvailabilityHint } from './bookingMessagePolicy.service.js';
import { resolveRequestAddress, normalizeSpokenAddress, extractCustomerPostalCode } from './customerAddress.service.js';
import escalateToHumanTool from "../../helpers/ai/tools/escalateToHuman.tool.js";
import searchServicesTool from "../../helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../../helpers/ai/tools/validateServiceArea.tool.js";
import { saveBookingTransition } from "./bookingTurnState.repository.js";
import { bookingInquiryOperations } from "./bookingInquiryRuntime.js";
const { cleanStreetAddress, parseStreetAddress, buildAvailabilityPricingNote } = bookingInquiryOperations;

export async function collectBookingService({ business, lead, activeConversation, text, smsIntent }) {
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
    await saveBookingTransition(activeConversation, "service_requested");
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
  const address = resolveRequestAddress({ customerMessage: text, lead, conversation: activeConversation });
  await saveBookingTransition(activeConversation, "service_selected", {
    serviceOffering: selectedService.id,
    streetAddress: cleanStreetAddress(address),
    postalCode: extractCustomerPostalCode(address),
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
  return null;
}

export async function collectBookingStreetAddress(context) {
  const { lead, activeConversation, text } = context;
  const address = resolveRequestAddress({ customerMessage: text, lead, conversation: activeConversation });
  const { street, valid } = parseStreetAddress(address);
  const suppliedZip = extractCustomerPostalCode(address);

  if (!valid) {
    await saveBookingTransition(activeConversation, "street_address_requested", {
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
    await saveBookingTransition(activeConversation, "postal_code_requested", {
      streetAddress: street,
    });
    return {
      handled: true,
      result: fixedResult({
        reply: "Thanks. What is the 5-digit ZIP code for that address?",
      }),
    };
  }

  const areaReview = await reviewBookingServiceArea(context, suppliedZip);
  if (areaReview) return areaReview;

  await saveBookingTransition(activeConversation, "location_verified", {
    streetAddress: street,
    postalCode: suppliedZip,
  });

  return continueAfterLocation(context);
}

export async function collectBookingPostalCode(context) {
  const { lead, activeConversation, text } = context;
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

  const areaReview = await reviewBookingServiceArea(context, zip);
  if (areaReview) return areaReview;

  if (lead && address) {
    lead.address = extractCustomerPostalCode(address) ? address : `${address}, ${zip}`;
    await lead.save();
  }
  await saveBookingTransition(activeConversation, "location_verified", {
    ...(address ? { streetAddress: cleanStreetAddress(address) } : {}),
    postalCode: zip,
  });

  return continueAfterLocation(context);
}

async function reviewBookingServiceArea({ business, lead, activeConversation, text }, postalCode) {
  const area = await validateServiceAreaTool({
    businessId: business._id,
    postalCode,
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
}

function continueAfterLocation({ business, lead, activeConversation, text, bookingChannel, bookingSource, handle }) {
  if (activeConversation.bookingState?.availabilityInquiry) {
    return handle({
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
  if (hasBookingAvailabilityHint(text, business.timezone || "America/New_York")) return null;
  return {
    handled: true,
    result: fixedResult({
      reply:
        "What day and time work best? You can text naturally—for example: tomorrow at 2, day after tomorrow around 3ish, Friday morning, Aug 10 at 2:30, or after work.",
    }),
  };
}
