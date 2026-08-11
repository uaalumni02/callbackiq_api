import crypto from "crypto";
import twilio from "twilio";

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const TOKEN_TTL_SECONDS = 600;
const RECENT_SESSION_WINDOW_MS = 30_000;
const TERMINAL_CLIENT_STATUSES = new Set(["disconnected", "error", "canceled"]);
const TERMINAL_PROSPECT_STATUSES = new Set([
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

const clean = (value) => String(value || "").trim();

const normalizeDemoPhoneToE164 = (value = "") => {
  const raw = clean(value);
  if (!raw) return "";

  const compact = raw.replace(/[()\s.-]/g, "");
  if (E164_PATTERN.test(compact)) return compact;

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
};

const callError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const requirePhone = (value, code, message) => {
  const normalized = normalizeDemoPhoneToE164(value);
  if (!E164_PATTERN.test(normalized)) throw callError(code, message);
  return normalized;
};

const requireEnv = (value, code, message) => {
  const normalized = clean(value);
  if (!normalized) throw callError(code, message, 503);
  return normalized;
};

const resolveBrowserCallConfig = () => ({
  accountSid: requireEnv(
    process.env.TWILIO_ACCOUNT_SID,
    "DEMO_BROWSER_CALL_ACCOUNT_NOT_CONFIGURED",
    "Browser calling requires TWILIO_ACCOUNT_SID.",
  ),
  apiKeySid: requireEnv(
    process.env.DEMO_TWILIO_API_KEY_SID ||
      process.env.TWILIO_API_KEY_SID ||
      process.env.TWILIO_API_KEY,
    "DEMO_BROWSER_CALL_API_KEY_NOT_CONFIGURED",
    "Browser calling requires DEMO_TWILIO_API_KEY_SID (or TWILIO_API_KEY_SID/TWILIO_API_KEY).",
  ),
  apiKeySecret: requireEnv(
    process.env.DEMO_TWILIO_API_KEY_SECRET ||
      process.env.TWILIO_API_KEY_SECRET ||
      process.env.TWILIO_API_SECRET,
    "DEMO_BROWSER_CALL_API_SECRET_NOT_CONFIGURED",
    "Browser calling requires DEMO_TWILIO_API_KEY_SECRET (or TWILIO_API_KEY_SECRET/TWILIO_API_SECRET).",
  ),
  twimlAppSid: requireEnv(
    process.env.DEMO_TWILIO_TWIML_APP_SID || process.env.TWILIO_TWIML_APP_SID,
    "DEMO_BROWSER_CALL_APP_NOT_CONFIGURED",
    "Browser calling requires DEMO_TWILIO_TWIML_APP_SID (or TWILIO_TWIML_APP_SID).",
  ),
  callerId: requirePhone(
    process.env.DEMO_OUTBOUND_CALLER_ID || process.env.TWILIO_PHONE_NUMBER,
    "DEMO_BROWSER_CALL_CALLER_ID_NOT_CONFIGURED",
    "Browser calling requires DEMO_OUTBOUND_CALLER_ID (or TWILIO_PHONE_NUMBER) to be a Twilio-owned or verified E.164 caller ID.",
  ),
});

const resolveStatusCallbackBase = () => {
  const explicit = clean(process.env.DEMO_BROWSER_CALL_STATUS_CALLBACK_URL);
  if (explicit) return explicit;

  const base = clean(
    process.env.TWILIO_WEBHOOK_BASE_URL || process.env.VOICE_HTTP_PUBLIC_URL,
  ).replace(/\/+$/, "");

  if (!base) {
    throw callError(
      "DEMO_BROWSER_CALL_WEBHOOK_NOT_CONFIGURED",
      "Browser calling requires TWILIO_WEBHOOK_BASE_URL, VOICE_HTTP_PUBLIC_URL, or DEMO_BROWSER_CALL_STATUS_CALLBACK_URL.",
      503,
    );
  }

  return `${base}/api/demo-requests/browser-call-status`;
};

const buildStatusCallbackUrl = ({ demoId, attemptId }) => {
  const url = new URL(resolveStatusCallbackBase());
  url.searchParams.set("demoRequestId", String(demoId));
  url.searchParams.set("attemptId", String(attemptId));
  return url.toString();
};

const browserIdentity = (actorId) => {
  const source = clean(actorId) || crypto.randomUUID();
  const safe = source.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80);
  return `demo_admin_${safe}`;
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

const buildProspectDialTwiml = ({ prospectPhone, callerId, statusCallback }) => {
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
    prospectPhone,
  );

  return response.toString();
};

const buildFailureTwiml = () => {
  const response = new twilio.twiml.VoiceResponse();
  response.say(
    { voice: "alice" },
    "We could not connect this CallBackIQ demo call. Please try again.",
  );
  response.hangup();
  return response.toString();
};

const activityIsRecentlyActive = (activity, now = new Date()) => {
  if (!activity || activity.channel !== "phone" || !activity.callAttemptId) return false;
  const startedAt = new Date(activity.at || 0).getTime();
  if (!startedAt || now.getTime() - startedAt > RECENT_SESSION_WINDOW_MS) return false;

  const clientStatus = clean(activity.clientCallStatus).toLowerCase();
  const prospectStatus = clean(activity.prospectCallStatus).toLowerCase();
  if (TERMINAL_CLIENT_STATUSES.has(clientStatus)) return false;
  if (TERMINAL_PROSPECT_STATUSES.has(prospectStatus)) return false;
  return true;
};

class DemoBrowserCallService {
  static async createSession({
    DemoRequestModel,
    demoId,
    actorId = null,
    actorEmail = "",
    now = new Date(),
  }) {
    const demo = await DemoRequestModel.findById(demoId).select(
      "fullName phone phoneE164 outreachActivities status contactedAt",
    );
    if (!demo) return null;

    requirePhone(
      demo.phoneE164 || demo.phone,
      "DEMO_BROWSER_CALL_PHONE_MISSING",
      "This demo request does not have a valid phone number to call.",
    );

    const latestPhoneActivity = [...(demo.outreachActivities || [])]
      .reverse()
      .find((activity) => activity?.channel === "phone");
    if (activityIsRecentlyActive(latestPhoneActivity, now)) {
      throw callError(
        "DEMO_BROWSER_CALL_ALREADY_ACTIVE",
        "A demo call is already being started. Wait a moment before trying again.",
        409,
      );
    }

    const config = resolveBrowserCallConfig();
    // Resolve this now so a missing public callback URL does not create a dead session.
    resolveStatusCallbackBase();

    const attemptId = crypto.randomUUID();
    const token = buildAccessToken({ config, actorId });

    const updated = await DemoRequestModel.findByIdAndUpdate(
      demoId,
      {
        $push: {
          outreachActivities: {
            type: "call_initiated",
            channel: "phone",
            actor: actorId || null,
            actorEmail: clean(actorEmail).toLowerCase(),
            at: now,
            callAttemptId: attemptId,
            clientCallStatus: "ready",
          },
        },
        $set: {
          lastOutreachAt: now,
          lastOutreachChannel: "phone",
        },
      },
      { new: true, runValidators: true },
    );

    return {
      demo: updated,
      session: {
        token,
        attemptId,
        expiresIn: TOKEN_TTL_SECONDS,
        callerId: config.callerId,
        connectParams: {
          demoRequestId: String(demoId),
          attemptId,
        },
      },
    };
  }

  static async buildTwiml({
    DemoRequestModel,
    demoId,
    attemptId,
    providerCallSid = "",
  }) {
    const demo = await DemoRequestModel.findOne({
      _id: demoId,
      "outreachActivities.callAttemptId": attemptId,
    }).select("phone phoneE164 outreachActivities");

    if (!demo) {
      throw callError(
        "DEMO_BROWSER_CALL_SESSION_NOT_FOUND",
        "The demo call session could not be found.",
        404,
      );
    }

    const prospectPhone = requirePhone(
      demo.phoneE164 || demo.phone,
      "DEMO_BROWSER_CALL_PHONE_MISSING",
      "This demo request does not have a valid phone number to call.",
    );
    const config = resolveBrowserCallConfig();
    const statusCallback = buildStatusCallbackUrl({ demoId, attemptId });

    await DemoRequestModel.findOneAndUpdate(
      { _id: demoId, "outreachActivities.callAttemptId": attemptId },
      {
        $set: {
          "outreachActivities.$.providerCallSid": clean(providerCallSid),
        },
      },
      { new: true, runValidators: true },
    );

    return buildProspectDialTwiml({
      prospectPhone,
      callerId: config.callerId,
      statusCallback,
    });
  }

  static async applyProspectStatus({
    DemoRequestModel,
    demoId,
    attemptId,
    payload,
    now = new Date(),
  }) {
    if (!demoId || !attemptId) return null;
    const providerStatus = clean(payload?.CallStatus).toLowerCase();
    if (!providerStatus) return null;

    const set = {
      "outreachActivities.$.prospectCallStatus": providerStatus,
      "outreachActivities.$.providerChildCallSid": clean(payload?.CallSid),
    };

    if (providerStatus === "in-progress") {
      set["outreachActivities.$.answeredAt"] = now;
    }

    if (TERMINAL_PROSPECT_STATUSES.has(providerStatus)) {
      set["outreachActivities.$.completedAt"] = now;
      const duration = Number(payload?.CallDuration);
      if (Number.isFinite(duration) && duration >= 0) {
        set["outreachActivities.$.durationSeconds"] = Math.round(duration);
      }
    }

    return DemoRequestModel.findOneAndUpdate(
      { _id: demoId, "outreachActivities.callAttemptId": attemptId },
      { $set: set },
      { new: true, runValidators: true },
    );
  }

  static async applyClientStatus({
    DemoRequestModel,
    demoId,
    attemptId,
    status,
    providerCallSid = "",
    errorCode = "",
    now = new Date(),
  }) {
    const normalizedStatus = clean(status).toLowerCase();
    const set = {
      "outreachActivities.$.clientCallStatus": normalizedStatus,
    };

    if (providerCallSid) {
      set["outreachActivities.$.providerCallSid"] = clean(providerCallSid);
    }
    if (errorCode) {
      set["outreachActivities.$.providerErrorCode"] = clean(errorCode).slice(0, 100);
    }
    if (TERMINAL_CLIENT_STATUSES.has(normalizedStatus)) {
      set["outreachActivities.$.clientCompletedAt"] = now;
    }

    return DemoRequestModel.findOneAndUpdate(
      { _id: demoId, "outreachActivities.callAttemptId": attemptId },
      { $set: set },
      { new: true, runValidators: true },
    );
  }
}

export {
  TOKEN_TTL_SECONDS,
  TERMINAL_CLIENT_STATUSES,
  TERMINAL_PROSPECT_STATUSES,
  activityIsRecentlyActive,
  buildAccessToken,
  buildFailureTwiml,
  buildProspectDialTwiml,
  buildStatusCallbackUrl,
  normalizeDemoPhoneToE164,
  resolveBrowserCallConfig,
};
export default DemoBrowserCallService;
