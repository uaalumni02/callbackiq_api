import ContactPreference from "../../models/contactPreference.js";
import normalizePhone from "../../helpers/normalizePhone.js";
import { SAFE_REPLIES } from "../../helpers/ai/aiGuardrails.js";
import { isSoftOptOutPhrase } from "./smsCompliance.service.js";

const TWILIO_STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
// YES is an ordinary conversation answer unless Twilio supplies OptOutType=START.
const TWILIO_START_KEYWORDS = new Set(["START", "UNSTOP"]);
const TWILIO_HELP_KEYWORDS = new Set(["HELP", "INFO"]);

const normalizeKeyword = (value) =>
  String(value || "")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim()
    .toUpperCase();

// Twilio manages keywords only when the entire inbound body is an exact
// supported keyword. Keep this stricter than normalizeKeyword so punctuation
// variants are not mistaken for provider-managed events.
const normalizeProviderKeyword = (value) =>
  String(value || "").trim().toUpperCase();

const normalizeOptOutType = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

export const isStartKeyword = (value) =>
  TWILIO_START_KEYWORDS.has(normalizeKeyword(value));

export const classifyInboundSmsCommand = (
  messageBody,
  { twilioOptOutType = "" } = {},
) => {
  const keyword = normalizeKeyword(messageBody);
  const providerKeyword = normalizeProviderKeyword(messageBody);
  const optOutType = normalizeOptOutType(twilioOptOutType);

  if (
    optOutType === "STOP" ||
    TWILIO_STOP_KEYWORDS.has(providerKeyword)
  ) {
    return {
      handled: true,
      action: "opt_out",
      providerManaged: true,
      softOptOut: false,
      keyword: providerKeyword || keyword || "STOP",
      optOutType: optOutType || "STOP",
    };
  }

  const punctuatedStop =
    keyword !== providerKeyword &&
    TWILIO_STOP_KEYWORDS.has(keyword);
  const softOptOut =
    punctuatedStop || isSoftOptOutPhrase(messageBody);
  if (softOptOut) {
    return {
      handled: true,
      action: "opt_out",
      providerManaged: false,
      softOptOut: true,
      keyword: keyword || String(messageBody || "").trim(),
      optOutType: "",
    };
  }

  if (
    optOutType === "START" ||
    TWILIO_START_KEYWORDS.has(providerKeyword)
  ) {
    return {
      handled: true,
      action: "opt_in",
      providerManaged: true,
      softOptOut: false,
      keyword: providerKeyword || keyword || "START",
      optOutType: optOutType || "START",
    };
  }

  if (
    optOutType === "HELP" ||
    TWILIO_HELP_KEYWORDS.has(providerKeyword)
  ) {
    return {
      handled: true,
      action: "help",
      providerManaged: true,
      softOptOut: false,
      keyword: providerKeyword || keyword || "HELP",
      optOutType: optOutType || "HELP",
    };
  }

  return {
    handled: false,
    action: "",
    providerManaged: false,
    softOptOut: false,
    keyword,
    optOutType,
  };
};

export const getSmsPreference = async ({ businessId, phone }) => {
  const normalizedPhone = normalizePhone(phone);
  if (!businessId || !normalizedPhone) return null;
  return ContactPreference.findOne({ business: businessId, phone: normalizedPhone });
};

export const isSmsSuppressed = async ({ businessId, phone }) => {
  const preference = await getSmsPreference({ businessId, phone });
  return preference?.smsStatus === "opted_out";
};

export const optOutSms = async ({
  businessId,
  phone,
  source = "twilio_keyword",
  keyword = "STOP",
}) => {
  const normalizedPhone = normalizePhone(phone);
  if (!businessId || !normalizedPhone) {
    throw new Error("businessId and phone are required to opt out SMS");
  }
  return ContactPreference.findOneAndUpdate(
    { business: businessId, phone: normalizedPhone },
    {
      $set: {
        smsStatus: "opted_out",
        optedOutAt: new Date(),
        optedInAt: null,
        source,
        lastKeyword: normalizeKeyword(keyword),
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );
};

export const optInSms = async ({
  businessId,
  phone,
  source = "twilio_keyword",
  keyword = "START",
}) => {
  const normalizedPhone = normalizePhone(phone);
  if (!businessId || !normalizedPhone) {
    throw new Error("businessId and phone are required to opt in SMS");
  }
  return ContactPreference.findOneAndUpdate(
    { business: businessId, phone: normalizedPhone },
    {
      $set: {
        smsStatus: "active",
        optedInAt: new Date(),
        optedOutAt: null,
        source,
        lastKeyword: normalizeKeyword(keyword),
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );
};

export const processInboundSmsCommand = async ({
  businessId,
  phone,
  messageBody,
  twilioOptOutType = "",
  suppressProviderManagedReply = false,
}) => {
  const classification = classifyInboundSmsCommand(messageBody, {
    twilioOptOutType,
  });

  if (!classification.handled) {
    return {
      ...classification,
      reply: "",
      allowOptedOutReply: false,
    };
  }

  if (classification.action === "opt_out") {
    await optOutSms({
      businessId,
      phone,
      source: classification.providerManaged
        ? "twilio_keyword"
        : "customer_request",
      keyword: classification.keyword || messageBody,
    });

    return {
      ...classification,
      reply:
        classification.providerManaged && suppressProviderManagedReply
          ? ""
          : SAFE_REPLIES.optOut,
      allowOptedOutReply:
        !classification.providerManaged || !suppressProviderManagedReply,
    };
  }

  if (classification.action === "opt_in") {
    /*
     * CALLBACKIQ_SOFT_OPTOUT_START_OWNERSHIP
     *
     * A natural-language opt-out such as "please stop texting me" is stored
     * locally by CallBackIQ but does not create a Twilio STOP block.
     *
     * In that state, a later exact START must:
     *   1. reactivate the local preference, and
     *   2. receive a CallBackIQ confirmation because Twilio may not reply.
     *
     * When the webhook actually contains OptOutType=START, Twilio has already
     * handled the opt-in response and we continue suppressing our duplicate.
     */
    const existingPreference = await getSmsPreference({
      businessId,
      phone,
    });

    const twilioConfirmedStart =
      normalizeOptOutType(twilioOptOutType) === "START";

    const locallyManagedOptOut =
      existingPreference?.smsStatus === "opted_out" &&
      existingPreference?.source === "customer_request" &&
      !twilioConfirmedStart;

    await optInSms({
      businessId,
      phone,
      source: locallyManagedOptOut
        ? "customer_request"
        : "twilio_keyword",
      keyword: classification.keyword || messageBody,
    });

    const suppressStartReply =
      classification.providerManaged &&
      suppressProviderManagedReply &&
      !locallyManagedOptOut;

    return {
      ...classification,
      reply: suppressStartReply
        ? ""
        : "You have been resubscribed and may receive automated text messages from this business. Reply STOP to opt out.",
      allowOptedOutReply: !suppressStartReply,
    };
  }

  if (classification.action === "help") {
    return {
      ...classification,
      reply:
        classification.providerManaged && suppressProviderManagedReply
          ? ""
          : SAFE_REPLIES.help,
      allowOptedOutReply:
        !classification.providerManaged || !suppressProviderManagedReply,
    };
  }

  return {
    ...classification,
    reply: "",
    allowOptedOutReply: false,
  };
};

export default {
  classifyInboundSmsCommand,
  getSmsPreference,
  isSmsSuppressed,
  isStartKeyword,
  optOutSms,
  optInSms,
  processInboundSmsCommand,
};
