import SchedulingPolicy from '../../models/schedulingPolicy.js';
import { customerAppointmentLabel } from './customerAppointmentPresentation.service.js';
import crypto from 'crypto';
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import Appointment from "../../models/appointment.js";
import AppointmentNotificationJob from "../../models/appointmentNotificationJob.js";
import Conversation from "../../models/conversation.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import Message from "../../models/message.js";
import { sendSms } from "../twilioSmsService.js";
import { getGoogleSettings } from "../integrations/integrationSettings.service.js";

const instanceId =
  process.env.INSTANCE_ID ||
  `${process.pid}:appointment-notifications:${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const formatAppointmentTime = (appointment, business) => customerAppointmentLabel(appointment, appointment.timezone || business.timezone);

const addressText = (appointment) =>
  [
    appointment.address?.street,
    appointment.address?.city,
    appointment.address?.state,
    appointment.address?.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

const getNotificationSettings = async (businessId) => {
  const connection = await IntegrationConnection.findOne({
    business: businessId,
    provider: "google_calendar",
  });

  const policy = await SchedulingPolicy.findOne({ business: businessId }).lean();
  const legacy = connection ? getGoogleSettings(connection) : {};
  return {
    customerRemindersEnabled: policy?.customerRemindersEnabled ?? legacy.customerRemindersEnabled ?? false,
    reminderHours: policy?.reminderHours ?? legacy.reminderHours ?? [24, 2],
    postAppointmentFollowUpEnabled: policy?.postAppointmentFollowUpEnabled ?? legacy.postAppointmentFollowUpEnabled ?? false,
    postAppointmentFollowUpDelayHours: policy?.postAppointmentFollowUpDelayHours ?? legacy.postAppointmentFollowUpDelayHours ?? 2,
  };
};

export const cancelAppointmentNotifications = async ({
  businessId,
  appointmentId,
  reason = "Appointment changed before notification delivery.",
  types = null,
}) =>
  AppointmentNotificationJob.updateMany(
    {
      business: businessId,
      appointment: appointmentId,
      status: { $in: ["scheduled", "processing"] },
      ...(Array.isArray(types) && types.length
        ? { type: { $in: types } }
        : {}),
    },
    {
      $set: {
        status: "canceled",
        canceledAt: new Date(),
        lockedAt: null,
        lockedBy: "",
        failureReason: reason,
      },
    },
  );

export const scheduleAppointmentReminders = async ({
  appointment,
  settingsOverride = null,
}) => {
  const settings =
    settingsOverride || (await getNotificationSettings(appointment.business));
  await cancelAppointmentNotifications({
    businessId: appointment.business,
    appointmentId: appointment._id,
    reason: "Appointment reminder schedule refreshed.",
    types: ["reminder"],
  });

  if (
    !settings?.customerRemindersEnabled ||
    appointment.status !== "confirmed"
  ) {
    return [];
  }

  const now = Date.now();
  const jobs = [];
  for (const hoursBefore of settings.reminderHours || [24, 2]) {
    const scheduledFor = new Date(
      new Date(appointment.startAt).getTime() -
        Number(hoursBefore) * 60 * 60 * 1000,
    );
    if (scheduledFor.getTime() <= now + 60_000) continue;

    jobs.push(
      await AppointmentNotificationJob.findOneAndUpdate(
        {
          business: appointment.business,
          appointment: appointment._id,
          key: `reminder:${hoursBefore}`,
        },
        {
          $set: {
            attempts: 0,
            lead: appointment.lead || null,
            conversation: appointment.conversation || null,
            type: "reminder",
            hoursBefore,
            scheduledFor,
            status: "scheduled",
            lockedAt: null,
            lockedBy: "",
            sentAt: null,
            canceledAt: null,
            providerMessageId: "",
            failureReason: "",
          },
        },
        { upsert: true, new: true },
      ),
    );
  }
  return jobs;
};

export const refreshUpcomingAppointmentNotifications = async ({
  businessId,
  limit = 250,
}) => {
  const settings = await getNotificationSettings(businessId);
  if (!settings) return { refreshed: 0, connected: false };
  const appointments = await Appointment.find({
    business: businessId,
    status: "confirmed",
    startAt: { $gt: new Date() },
  })
    .sort({ startAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 250, 1), 500));
  let refreshed = 0;
  let failed = 0;
  for (const appointment of appointments) {
    try {
      await scheduleAppointmentReminders({
        appointment,
        settingsOverride: settings,
      });
      refreshed += 1;
    } catch (error) {
      failed += 1;
      safeConsole.error("[appointment.notifications.refresh_failed]", {
        businessId: String(businessId),
        appointmentId: String(appointment._id),
        error: error.message,
      });
    }
  }
  return {
    refreshed,
    failed,
    connected: true,
    enabled: settings.customerRemindersEnabled !== false,
  };
};

export const scheduleAppointmentChangeNotice = async ({
  appointment,
  key,
  body,
}) =>
  AppointmentNotificationJob.findOneAndUpdate(
    {
      business: appointment.business,
      appointment: appointment._id,
      key: `change_notice:${String(key || "provider_change").slice(0, 66)}`,
    },
    {
      [(["business_approval_confirmed", "approval_hold_expired"].includes(key) || (String(key).startsWith("reply_") || String(key).startsWith("lifecycle_"))) ? "$setOnInsert" : "$set"]: {
        attempts: 0,
        lead: appointment.lead || null,
        conversation: appointment.conversation || null,
        type: "change_notice",
        hoursBefore: null,
        body: String(body || "").trim(),
        scheduledFor: new Date(),
        status: "scheduled",
        lockedAt: null,
        lockedBy: "",
        sentAt: null,
        canceledAt: null,
        providerMessageId: "",
        failureReason: "",
      },
    },
    { upsert: true, new: true },
  );

export const schedulePostAppointmentFollowUp = async ({ appointment }) => {
  const settings = await getNotificationSettings(appointment.business);
  if (
    !settings?.postAppointmentFollowUpEnabled ||
    appointment.status !== "completed" ||
    !appointment.completedAt
  ) {
    return null;
  }

  const scheduledFor = new Date(
    new Date(appointment.completedAt).getTime() +
      Number(settings.postAppointmentFollowUpDelayHours || 2) *
        60 *
        60 *
        1000,
  );
  return AppointmentNotificationJob.findOneAndUpdate(
    {
      business: appointment.business,
      appointment: appointment._id,
      key: "follow_up",
    },
    {
      $setOnInsert: {
        attempts: 0,
        lead: appointment.lead || null,
        conversation: appointment.conversation || null,
        type: "follow_up",
        hoursBefore: null,
        scheduledFor,
        status: "scheduled",
        lockedAt: null,
        lockedBy: "",
        sentAt: null,
        canceledAt: null,
        providerMessageId: "",
        failureReason: "",
      },
    },
    { upsert: true, new: true },
  );
};

const reminderBody = ({ job, appointment, business }) => {
  const businessName = business.businessName || "The service team";
  const serviceName =
    appointment.serviceOffering?.name || "service";
  const time = formatAppointmentTime(appointment, business);
  const location = addressText(appointment);

  if (job.type === "follow_up") {
    return `${businessName}: Thanks for choosing us for your ${serviceName}. Reply here if you need follow-up help or have any questions.`;
  }

  const lead = Number(job.hoursBefore) >= 12 ? "Reminder" : "Upcoming visit";
  return `${businessName}: ${lead}—your ${serviceName} appointment is ${time}${
    location ? ` at ${location}` : ""
  }. Reply C to confirm or R to reschedule.`;
};

const storeOutboundMessage = async ({
  appointment,
  business,
  body,
  result,
  job,
}) => {
  if (!appointment.conversation) return;
  if (!result.sid) throw new Error('Provider receipt is missing for appointment notification.');
  await Message.findOneAndUpdate({ business: business._id, provider: 'twilio', providerMessageId: result.sid }, { $setOnInsert: {
    business: business._id,
    conversation: appointment.conversation,
    lead: appointment.lead || null,
    direction: "outbound",
    from: business.phone,
    to: appointment.customerPhone,
    body,
    provider: "twilio",
    providerMessageId: result.sid || "",
    status: result.suppressed ? "suppressed" : result.status || "sent",
    isAiGenerated: false,
    generatedBy: "automation",
    usageCategory:
      job.type === "follow_up"
        ? "appointment_follow_up"
        : job.type === "change_notice"
          ? "appointment_change_notice"
          : "appointment_reminder",
    actorType: "automation",
    segmentCount: result.segmentCount || 1,
    encoding: result.encoding || "",
    metadata: {
      appointmentId: String(appointment._id),
      appointmentNotificationKey: job.key,
    },
  } }, { upsert: true, new: true });
  await Conversation.updateOne(
    { _id: appointment.conversation, business: business._id },
    { $set: { lastMessage: body, lastMessageAt: new Date() } },
  );
};

export const recoverStaleAppointmentNotificationLocks = async () => {
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  return AppointmentNotificationJob.updateMany(
    { status: "processing", lockedAt: { $lte: staleBefore } },
    {
      $set: {
        status: "scheduled",
        scheduledFor: new Date(),
        lockedAt: null,
        lockedBy: "",
        failureReason: "Recovered stale notification worker lock.",
      },
    },
  );
};

export const processNextAppointmentNotification = async () => {
  let job = await AppointmentNotificationJob.findOneAndUpdate(
    {
      status: "scheduled",
      scheduledFor: { $lte: new Date() },
      lockedAt: null,
    },
    {
      $set: {
        status: "processing",
        lockedAt: new Date(),
        lockedBy: instanceId,
      },
      $inc: { attempts: 1 },
    },
    { sort: { scheduledFor: 1 }, new: true },
  );
  if (!job) return null;

  const populated = await AppointmentNotificationJob.findById(job._id)
    .populate("business")
    .populate({
      path: "appointment",
      populate: { path: "serviceOffering", select: "name" },
    });
  if (
    !populated ||
    populated.status !== "processing" ||
    populated.lockedBy !== instanceId
  ) {
    return populated || job;
  }
  job = populated;
  const appointment = job.appointment;
  const business = job.business;
  const requiredStatus =
    job.type === "follow_up"
      ? "completed"
      : job.type === "reminder" || job.key === "change_notice:business_approval_confirmed" || String(job.key).startsWith("change_notice:reply_")
        ? "confirmed"
        : null;

  if (
    !appointment ||
    !business ||
    (String(job.key).startsWith('change_notice:lifecycle_') &&
      (job.key !== `change_notice:${appointment.lifecycleNotice?.key}` ||
        (['lifecycle_confirmed', 'lifecycle_rescheduled'].includes(appointment.lifecycleNotice?.key) && appointment.status !== 'confirmed') ||
        (appointment.lifecycleNotice?.key === 'lifecycle_canceled' && appointment.status !== 'canceled') ||
        (appointment.lifecycleNotice?.key === 'lifecycle_declined' && appointment.status !== 'failed') ||
        (appointment.lifecycleNotice?.key?.startsWith('lifecycle_change_declined_') && appointment.status !== 'confirmed'))) ||
    (job.key === "change_notice:approval_hold_expired" && !(appointment.status === "failed" && /hold expired/i.test(appointment.failureReason || ""))) ||
    (requiredStatus && appointment.status !== requiredStatus)
  ) {
    job.status = "canceled";
    job.canceledAt = new Date();
    job.lockedAt = null;
    job.lockedBy = "";
    job.failureReason = "Appointment no longer qualifies for this notification.";
    await job.save();
    return job;
  }
  if (
    job.type === "reminder" &&
    new Date(appointment.startAt).getTime() <= Date.now()
  ) {
    job.status = "canceled";
    job.canceledAt = new Date();
    job.lockedAt = null;
    job.lockedBy = "";
    job.failureReason = "Appointment start time passed before reminder delivery.";
    await job.save();
    return job;
  }

  if (job.type === 'reminder' || job.type === 'follow_up') {
    const settings = await getNotificationSettings(business._id);
    if (!(job.type === 'reminder' ? settings.customerRemindersEnabled : settings.postAppointmentFollowUpEnabled)) {
      job.status = 'canceled'; job.canceledAt = new Date(); job.lockedAt = null; job.lockedBy = '';
      job.failureReason = 'Customer notification disabled in scheduling preferences.';
      await job.save(); return job;
    }
  }

  const body =
    job.type === "change_notice" && String(job.body || "").trim()
      ? String(job.body).trim()
      : reminderBody({ job, appointment, business });
  try {
    const result = await sendSms({
      business,
      to: appointment.customerPhone,
      body,
      source:
        job.type === "follow_up"
          ? "appointment_follow_up"
          : job.type === "change_notice"
            ? "appointment_change_notice"
            : "appointment_reminder",
      usageCategory:
        job.type === "follow_up"
          ? "appointment_follow_up"
          : job.type === "change_notice"
            ? "appointment_change_notice"
            : "appointment_reminder",
      conversationId: appointment.conversation || null,
      leadId: appointment.lead || null,
      metadata: {
        appointmentId: String(appointment._id),
        appointmentNotificationKey: job.key,
        appointmentNotificationJobId: String(job._id),
        // The provider may accept a text before job/message persistence fails.
        // Replaying the same notice must recover its receipt, never resend it.
        idempotencyKey: `appointment-notice:${business._id}:${job._id}:${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}`,

      },
    });

    if (result.policyBlocked) {
      job.status = "scheduled";
      const retryAt = new Date(result.usage?.retryAt || result.sendWindow?.nextAllowedAt || 0);
      job.scheduledFor = Number.isFinite(retryAt.getTime()) && retryAt.getTime() > Date.now()
        ? retryAt : new Date(Date.now() + 60 * 60_000);
      job.lockedAt = null;
      job.lockedBy = "";
      job.failureReason = result.reason || "SMS send window blocked delivery.";
      await job.save();
      return job;
    }
    if (result.suppressed) {
      job.status = "canceled";
      job.canceledAt = new Date();
      job.lockedAt = null;
      job.lockedBy = "";
      job.failureReason = result.reason || "Customer SMS is suppressed.";
      await job.save();
      return job;
    }

    if (!result?.sid) throw new Error('SMS provider acceptance could not be verified.');
    await storeOutboundMessage({ appointment, business, body, result, job });
    job.status = "sent";
    job.sentAt = new Date();
    job.providerMessageId = result.sid || "";
    job.lockedAt = null;
    job.lockedBy = "";
    job.failureReason = "";
    await job.save();
    return job;
  } catch (error) {
    job.status = job.attempts >= 3 ? "failed" : "scheduled";
    job.scheduledFor = new Date(Date.now() + 15 * 60_000);
    job.lockedAt = null;
    job.lockedBy = "";
    job.failureReason = error.message;
    await job.save();
    return job;
  }
};

export const processDueAppointmentNotifications = async (limit = 25, { concurrency = 1 } = {}) => {
  const results = [];
  let remaining = Math.max(1, Math.min(500, Number(limit) || 25));
  const lanes = Math.max(1, Math.min(10, Number(concurrency) || 1));
  // Atomic claims assign each job to one lane. Existing send identities remain
  // unchanged, so recovery continues to reuse provider receipts.
  const outcomes = await Promise.allSettled(Array.from({ length: lanes }, async () => {
    while (remaining > 0) {
      remaining--;
      const job = await processNextAppointmentNotification();
      if (!job) break;
      results.push(job);
    }
  }));
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
};
