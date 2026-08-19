import crypto from "crypto";
import twilio from "twilio";

import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

const OWNER_BROWSER_CALL_TYPE = "owner_lead";
const TOKEN_TTL_SECONDS = 600;
const STATUS_SIGNATURE_GRACE_SECONDS = 24 * 60 * 60;

const clean = (value) => String(value || "").trim();

const callError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const requireEnv = (value, code, message) => {
  const normalized = clean(value);
  if (!normalized) throw callError(code, message, 503);
  return normalized;
};

const resolveSharedBrowserCallConfig = () => ({
  accountSid: requireEnv(
    process.env.TWILIO_ACCOUNT_SID,
    "OWNER_BROWSER_CALL_ACCOUNT_NOT_CONFIGURED",
    "Browser calling requires TWILIO_ACCOUNT_SID.",
  ),
  apiKeySid: requireEnv(
    process.env.DEMO_TWILIO_API_KEY_SID ||
      process.env.TWILIO_API_KEY_SID ||
      process.env.TWILIO_API_KEY,
    "OWNER_BROWSER_CALL_API_KEY_NOT_CONFIGURED",
    "Browser calling requires the Twilio API key already used by demo browser calling.",
  ),
  apiKeySecret: requireEnv(
    process.env.DEMO_TWILIO_API_KEY_SECRET ||
      process.env.TWILIO_API_KEY_SECRET ||
      process.env.TWILIO_API_SECRET,
    "OWNER_BROWSER_CALL_API_SECRET_NOT_CONFIGURED",
    "Browser calling requires the Twilio API secret already used by demo browser calling.",
  ),
  twimlAppSid: requireEnv(
    process.env.DEMO_TWILIO_TWIML_APP_SID ||
      process.env.TWILIO_TWIML_APP_SID,
    "OWNER_BROWSER_CALL_APP_NOT_CONFIGURED",
    "Browser calling requires the TwiML App already used by demo browser calling.",
  ),
});

const requireBusinessCallerId = (value) => {
  const callerId = normalizePhoneToE164(value);
  if (!callerId) {
    throw callError(
      "OWNER_BROWSER_CALL_CALLER_ID_NOT_CONFIGURED",
      "This business needs an active CallBackIQ tracking number before browser calling can be used.",
      409,
    );
  }
  return callerId;
};

const resolveStatusCallbackBase = () => {
  const explicit = clean(
    process.env.OWNER_BROWSER_CALL_STATUS_CALLBACK_URL ||
      process.env.DEMO_BROWSER_CALL_STATUS_CALLBACK_URL,
  );
  if (explicit) return explicit;

  const base = clean(
    process.env.TWILIO_WEBHOOK_BASE_URL || process.env.VOICE_HTTP_PUBLIC_URL,
  ).replace(/\/+$/, "");

  if (!base) {
    throw callError(
      "OWNER_BROWSER_CALL_WEBHOOK_NOT_CONFIGURED",
      "Browser calling requires TWILIO_WEBHOOK_BASE_URL, VOICE_HTTP_PUBLIC_URL, or the existing demo browser-call status callback URL.",
      503,
    );
  }

  // Reuse the already signature-validated demo Voice SDK status endpoint.
  return `${base}/api/demo-requests/browser-call-status`;
};

const browserIdentity = (actorId) => {
  const source = clean(actorId) || crypto.randomUUID();
  const safe = source.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80);
  return `owner_${safe}`;
};

const buildAccessToken = ({ config, actorId }) => {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    {
      identity: browserIdentity(actorId),
      ttl: TOKEN_TTL_SECONDS,
    },
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: config.twimlAppSid,
      incomingAllow: false,
    }),
  );

  return token.toJwt();
};

const signaturePayload = ({
  businessId,
  leadId,
  attemptId,
  expiresAt,
}) =>
  [
    OWNER_BROWSER_CALL_TYPE,
    clean(businessId),
    clean(leadId),
    clean(attemptId),
    clean(expiresAt),
  ].join(":");

const signOwnerBrowserCallSession = ({
  apiKeySecret,
  businessId,
  leadId,
  attemptId,
  expiresAt,
}) =>
  crypto
    .createHmac("sha256", apiKeySecret)
    .update(
      signaturePayload({
        businessId,
        leadId,
        attemptId,
        expiresAt,
      }),
    )
    .digest("hex");

const signaturesMatch = (left, right) => {
  const a = Buffer.from(clean(left), "utf8");
  const b = Buffer.from(clean(right), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const verifyOwnerBrowserCallSession = ({
  params,
  apiKeySecret,
  allowExpired = false,
  now = new Date(),
}) => {
  if (clean(params?.callType).toLowerCase() !== OWNER_BROWSER_CALL_TYPE) {
    return false;
  }

  const businessId = clean(params?.businessId);
  const leadId = clean(params?.leadId);
  const attemptId = clean(params?.attemptId);
  const expiresAt = Number(params?.expiresAt);
  const sessionSignature = clean(params?.sessionSignature);

  if (
    !businessId ||
    !leadId ||
    !attemptId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= 0 ||
    !sessionSignature
  ) {
    return false;
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!allowExpired && expiresAt < nowSeconds) return false;
  if (
    allowExpired &&
    expiresAt + STATUS_SIGNATURE_GRACE_SECONDS < nowSeconds
  ) {
    return false;
  }

  const expected = signOwnerBrowserCallSession({
    apiKeySecret,
    businessId,
    leadId,
    attemptId,
    expiresAt,
  });

  return signaturesMatch(expected, sessionSignature);
};

const buildConnectParams = ({
  config,
  businessId,
  leadId,
  attemptId,
  expiresAt,
}) => ({
  callType: OWNER_BROWSER_CALL_TYPE,
  businessId: String(businessId),
  leadId: String(leadId),
  attemptId,
  expiresAt: String(expiresAt),
  sessionSignature: signOwnerBrowserCallSession({
    apiKeySecret: config.apiKeySecret,
    businessId,
    leadId,
    attemptId,
    expiresAt,
  }),
});

const buildStatusCallbackUrl = ({ connectParams }) => {
  const url = new URL(resolveStatusCallbackBase());
  Object.entries(connectParams).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  return url.toString();
};

const buildOwnerProspectDialTwiml = ({
  customerPhone,
  callerId,
  statusCallback,
}) => {
  const response = new twilio.twiml.VoiceResponse();
  const dial = response.dial({
    callerId,
    answerOnBridge: true,
    timeout: 30,
  });

  dial.number(
    {
      statusCallback,
      statusCallbackMethod: "POST",
      statusCallbackEvent: "initiated ringing answered completed",
    },
    customerPhone,
  );

  return response.toString();
};

const buildFailureTwiml = () => {
  const response = new twilio.twiml.VoiceResponse();
  response.say(
    { voice: "alice" },
    "We could not connect this CallBackIQ customer call. Please try again.",
  );
  response.hangup();
  return response.toString();
};

const resolveTarget = async ({
  businessId,
  leadId,
  LeadModel = Lead,
  ConversationModel = Conversation,
}) => {
  const lead = await LeadModel.findOne({
    _id: leadId,
    business: businessId,
  })
    .select("customerName phone appointment")
    .lean();

  if (!lead) return null;

  const conversation = await ConversationModel.findOne({
    business: businessId,
    lead: leadId,
  })
    .sort({ updatedAt: -1 })
    .select("_id customerPhone customerName")
    .lean();

  const customerPhone = normalizePhoneToE164(
    lead.phone || conversation?.customerPhone,
  );

  return {
    lead,
    conversation,
    customerPhone,
    customerName:
      lead.customerName || conversation?.customerName || "Customer",
  };
};

const mapProspectStatus = (providerStatus) => {
  const normalized = clean(providerStatus).toLowerCase();
  if (normalized === "in-progress" || normalized === "answered") {
    return "answered";
  }
  if (normalized === "completed") return "answered";
  if (normalized === "busy") return "busy";
  if (normalized === "no-answer") return "no_answer";
  if (normalized === "failed" || normalized === "canceled") return "failed";
  return "";
};

const upsertCallLog = async ({
  businessId,
  target,
  callerId,
  payload,
  CallLogModel = CallLog,
}) => {
  const providerCallId = clean(payload?.CallSid);
  const status = mapProspectStatus(payload?.CallStatus);
  if (!providerCallId || !status) return null;

  const set = {
    business: businessId,
    lead: target.lead._id,
    conversation: target.conversation?._id || null,
    from: callerId,
    to: target.customerPhone,
    direction: "outbound",
    status,
    provider: "twilio",
    providerCallId,
    notes: "Outbound browser call from Inbox.",
  };

  const duration = Number(payload?.CallDuration);
  if (
    clean(payload?.CallStatus).toLowerCase() === "completed" &&
    Number.isFinite(duration) &&
    duration >= 0
  ) {
    set.durationSeconds = Math.round(duration);
  }

  const filter = { business: businessId, providerCallId };

  try {
    return await CallLogModel.findOneAndUpdate(
      filter,
      { $set: set },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    );
  } catch (error) {
    // A duplicate callback can race with another status callback. The unique
    // business/providerCallId index remains authoritative; retry as an update.
    if (error?.code !== 11000) throw error;

    return CallLogModel.findOneAndUpdate(
      filter,
      { $set: set },
      { new: true, runValidators: true },
    );
  }
};

class OwnerBrowserCallService {
  static async createSession({
    business,
    leadId,
    actorId = null,
    now = new Date(),
    LeadModel = Lead,
    ConversationModel = Conversation,
  }) {
    const businessId = business?._id;
    if (!businessId) {
      throw callError(
        "OWNER_BROWSER_CALL_BUSINESS_MISSING",
        "Business not found.",
        404,
      );
    }

    const target = await resolveTarget({
      businessId,
      leadId,
      LeadModel,
      ConversationModel,
    });

    if (!target) return null;

    if (!target.customerPhone) {
      throw callError(
        "OWNER_BROWSER_CALL_PHONE_MISSING",
        "This customer does not have a valid phone number to call.",
      );
    }

    const config = resolveSharedBrowserCallConfig();
    const callerId = requireBusinessCallerId(business.phone);

    // Resolve this before issuing the token so configuration failures do not
    // create a browser session that can never report provider status.
    resolveStatusCallbackBase();

    const attemptId = crypto.randomUUID();
    const expiresAt =
      Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS;
    const connectParams = buildConnectParams({
      config,
      businessId,
      leadId,
      attemptId,
      expiresAt,
    });

    return {
      lead: {
        id: String(target.lead._id),
        customerName: target.customerName,
        phone: target.customerPhone,
      },
      session: {
        token: buildAccessToken({ config, actorId }),
        attemptId,
        expiresIn: TOKEN_TTL_SECONDS,
        callerId,
        connectParams,
      },
    };
  }

  static async buildTwiml({
    params,
    BusinessModel = Business,
    LeadModel = Lead,
    ConversationModel = Conversation,
  }) {
    const config = resolveSharedBrowserCallConfig();

    if (
      !verifyOwnerBrowserCallSession({
        params,
        apiKeySecret: config.apiKeySecret,
      })
    ) {
      throw callError(
        "OWNER_BROWSER_CALL_SESSION_INVALID",
        "The customer call session is invalid or expired.",
        403,
      );
    }

    const business = await BusinessModel.findById(params.businessId)
      .select("phone trackingNumber.status")
      .lean();

    if (!business) {
      throw callError(
        "OWNER_BROWSER_CALL_BUSINESS_MISSING",
        "Business not found.",
        404,
      );
    }

    const callerId = requireBusinessCallerId(business.phone);
    const target = await resolveTarget({
      businessId: params.businessId,
      leadId: params.leadId,
      LeadModel,
      ConversationModel,
    });

    if (!target || !target.customerPhone) {
      throw callError(
        "OWNER_BROWSER_CALL_PHONE_MISSING",
        "This customer does not have a valid phone number to call.",
      );
    }

    const statusCallback = buildStatusCallbackUrl({
      connectParams: {
        callType: params.callType,
        businessId: params.businessId,
        leadId: params.leadId,
        attemptId: params.attemptId,
        expiresAt: params.expiresAt,
        sessionSignature: params.sessionSignature,
      },
    });

    return buildOwnerProspectDialTwiml({
      customerPhone: target.customerPhone,
      callerId,
      statusCallback,
    });
  }

  static async applyProspectStatus({
    params,
    payload,
    now = new Date(),
    BusinessModel = Business,
    LeadModel = Lead,
    ConversationModel = Conversation,
    CallLogModel = CallLog,
  }) {
    const config = resolveSharedBrowserCallConfig();

    if (
      !verifyOwnerBrowserCallSession({
        params,
        apiKeySecret: config.apiKeySecret,
        allowExpired: true,
        now,
      })
    ) {
      return null;
    }

    if (!mapProspectStatus(payload?.CallStatus)) return null;

    const business = await BusinessModel.findById(params.businessId)
      .select("phone")
      .lean();
    if (!business) return null;

    const callerId = requireBusinessCallerId(business.phone);
    const target = await resolveTarget({
      businessId: params.businessId,
      leadId: params.leadId,
      LeadModel,
      ConversationModel,
    });
    if (!target || !target.customerPhone) return null;

    return upsertCallLog({
      businessId: params.businessId,
      target,
      callerId,
      payload,
      CallLogModel,
    });
  }
}

export {
  OWNER_BROWSER_CALL_TYPE,
  STATUS_SIGNATURE_GRACE_SECONDS,
  TOKEN_TTL_SECONDS,
  buildAccessToken,
  buildFailureTwiml,
  buildOwnerProspectDialTwiml,
  buildStatusCallbackUrl,
  mapProspectStatus,
  requireBusinessCallerId,
  resolveSharedBrowserCallConfig,
  signOwnerBrowserCallSession,
  verifyOwnerBrowserCallSession,
};
export default OwnerBrowserCallService;
