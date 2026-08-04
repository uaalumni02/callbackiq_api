import Appointment from "../models/appointment.js";
import { logOperationalWarning } from "../helpers/logging/safeLogger.js";
import { normalizePhoneToE164 } from "./voicePhone.service.js";

const providers = new Map();

const withTimeout = async (promise, timeoutMs = 1800) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Voice job-status provider timed out.");
          error.code = "VOICE_JOB_STATUS_TIMEOUT";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const formatWindow = (appointment) => {
  if (!appointment?.startAt) return "";
  const zone = appointment.timezone || "America/New_York";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(appointment.startAt));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(appointment.startAt));
  return `${date} at ${time}`;
};

export const registerVoiceJobStatusProvider = (name, resolver) => {
  const key = String(name || "").trim().toLowerCase();
  if (!key || typeof resolver !== "function") {
    throw new TypeError("A provider name and resolver function are required.");
  }
  providers.set(key, resolver);
  return () => providers.delete(key);
};

const lookupProviderStatus = async ({ appointment, businessId, callerPhone }) => {
  const providerName = String(
    appointment?.provider || appointment?.externalProvider || "",
  )
    .trim()
    .toLowerCase();
  const resolver = providers.get(providerName);
  if (!resolver) return null;

  try {
    const result = await withTimeout(
      Promise.resolve(
        resolver({
          appointment,
          businessId,
          callerPhone,
          externalEventId:
            appointment?.providerEventId ||
            appointment?.externalEventId ||
            appointment?.calendarEventId ||
            "",
        }),
      ),
      Number(process.env.VOICE_JOB_STATUS_TIMEOUT_MS) || 1800,
    );
    if (!result?.verified) return null;
    return {
      found: true,
      verified: true,
      source: providerName,
      status: result.status || appointment.status,
      window: result.window || formatWindow(appointment),
      technicianStatus: result.technicianStatus || "",
      reply: String(result.reply || "").trim(),
    };
  } catch (error) {
    logOperationalWarning("voice.job_status_provider_failed", {
      provider: providerName,
      businessId,
      errorCode: error?.code || error?.name || "error",
    });
    return null;
  }
};

export const lookupExistingVoiceAppointment = async ({
  businessId,
  callerPhone,
}) => {
  const phone = normalizePhoneToE164(callerPhone);
  if (!businessId || !phone) return { found: false, verified: false };

  const appointment = await Appointment.findOne({
    business: businessId,
    customerPhone: phone,
    status: { $in: ["held", "confirmed", "rescheduled", "in_progress"] },
    startAt: { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
  })
    .sort({ startAt: 1 })
    .lean();

  if (!appointment) return { found: false, verified: true };

  const providerResult = await lookupProviderStatus({
    appointment,
    businessId,
    callerPhone: phone,
  });
  if (providerResult?.reply) return providerResult;

  const window = formatWindow(appointment);
  return {
    found: true,
    verified: true,
    source: "local_appointment",
    status: appointment.status,
    provider: appointment.provider,
    window,
    externalStatusAvailable: Boolean(providerResult),
    reply: `I found a ${appointment.status} appointment${
      window ? ` for ${window}` : ""
    }. I can’t verify the technician’s live location, so I’ll flag the team for an urgent status callback rather than guess.`,
  };
};

export default {
  lookupExistingVoiceAppointment,
  registerVoiceJobStatusProvider,
};
