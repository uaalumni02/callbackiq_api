import ContactPreference from "../../models/contactPreference.js";
import normalizePhone from "../../helpers/normalizePhone.js";
import {
  SAFE_REPLIES,
  isHelpKeyword,
  isStopKeyword,
} from "../../helpers/ai/aiGuardrails.js";

const START_KEYWORDS = new Set(["START", "UNSTOP"]);

const normalizeKeyword = (value) => {
  return String(value || "")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim()
    .toUpperCase();
};

export const isStartKeyword = (value) => {
  return START_KEYWORDS.has(normalizeKeyword(value));
};

export const getSmsPreference = async ({ businessId, phone }) => {
  const normalizedPhone = normalizePhone(phone);

  if (!businessId || !normalizedPhone) {
    return null;
  }

  return ContactPreference.findOne({
    business: businessId,
    phone: normalizedPhone,
  });
};

export const isSmsSuppressed = async ({ businessId, phone }) => {
  const preference = await getSmsPreference({
    businessId,
    phone,
  });

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
    {
      business: businessId,
      phone: normalizedPhone,
    },
    {
      $set: {
        smsStatus: "opted_out",
        optedOutAt: new Date(),
        optedInAt: null,
        source,
        lastKeyword: normalizeKeyword(keyword),
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
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
    {
      business: businessId,
      phone: normalizedPhone,
    },
    {
      $set: {
        smsStatus: "active",
        optedInAt: new Date(),
        optedOutAt: null,
        source,
        lastKeyword: normalizeKeyword(keyword),
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );
};

export const processInboundSmsCommand = async ({
  businessId,
  phone,
  messageBody,
}) => {
  if (isStopKeyword(messageBody)) {
    await optOutSms({
      businessId,
      phone,
      keyword: messageBody,
    });

    return {
      handled: true,
      action: "opt_out",
      reply: SAFE_REPLIES.optOut,
      allowOptedOutReply: true,
    };
  }

  if (isStartKeyword(messageBody)) {
    await optInSms({
      businessId,
      phone,
      keyword: messageBody,
    });

    return {
      handled: true,
      action: "opt_in",
      reply:
        "You have been resubscribed and may receive automated text messages from this business. Reply STOP to opt out.",
      allowOptedOutReply: true,
    };
  }

  if (isHelpKeyword(messageBody)) {
    return {
      handled: true,
      action: "help",
      reply: SAFE_REPLIES.help,
      allowOptedOutReply: true,
    };
  }

  return {
    handled: false,
    action: "",
    reply: "",
    allowOptedOutReply: false,
  };
};
