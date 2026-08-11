import DemoNotificationService from "./demoNotification.service.js";

const ACTIVITY_TYPE_BY_CHANNEL = {
  phone: "call_initiated",
  email: "email_initiated",
};

const contactError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const clean = (value) => String(value || "").trim();

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const textToEmailHtml = (body) => `
  <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
    ${escapeHtml(body).replace(/\n/g, "<br />")}
  </div>
`;

class DemoOutreachService {
  static async recordAttempt({
    DemoRequestModel,
    demoId,
    channel,
    actorId = null,
    actorEmail = "",
    now = new Date(),
  }) {
    const demo = await DemoRequestModel.findById(demoId).select(
      "email phone phoneE164",
    );
    if (!demo) return null;

    if (channel === "phone" && !clean(demo.phoneE164 || demo.phone)) {
      throw contactError(
        "DEMO_OUTREACH_PHONE_MISSING",
        "This demo request does not have a phone number to call.",
      );
    }

    if (channel === "email" && !clean(demo.email)) {
      throw contactError(
        "DEMO_OUTREACH_EMAIL_MISSING",
        "This demo request does not have an email address.",
      );
    }

    return DemoRequestModel.findByIdAndUpdate(
      demoId,
      {
        $push: {
          outreachActivities: {
            type: ACTIVITY_TYPE_BY_CHANNEL[channel],
            channel,
            actor: actorId || null,
            actorEmail: clean(actorEmail).toLowerCase(),
            at: now,
          },
        },
        $set: {
          lastOutreachAt: now,
          lastOutreachChannel: channel,
        },
      },
      { new: true, runValidators: true },
    );
  }

  static async sendEmail({
    DemoRequestModel,
    demoId,
    subject,
    body,
    actorId = null,
    actorEmail = "",
    now = new Date(),
  }) {
    const demo = await DemoRequestModel.findById(demoId).select("email");
    if (!demo) return null;

    const recipient = clean(demo.email);
    if (!recipient) {
      throw contactError(
        "DEMO_OUTREACH_EMAIL_MISSING",
        "This demo request does not have an email address.",
      );
    }

    const cleanSubject = clean(subject);
    const cleanBody = clean(body);
    const sent = await DemoNotificationService.send({
      to: recipient,
      subject: cleanSubject,
      html: textToEmailHtml(cleanBody),
    });

    if (!sent) {
      throw contactError(
        "DEMO_OUTREACH_EMAIL_SEND_FAILED",
        "Email could not be sent. Check the CallBackIQ email configuration and try again.",
      );
    }

    return DemoRequestModel.findByIdAndUpdate(
      demoId,
      {
        $push: {
          outreachActivities: {
            type: "email_sent",
            channel: "email",
            actor: actorId || null,
            actorEmail: clean(actorEmail).toLowerCase(),
            subject: cleanSubject,
            at: now,
          },
        },
        $set: {
          lastOutreachAt: now,
          lastOutreachChannel: "email",
        },
      },
      { new: true, runValidators: true },
    );
  }
}

export { ACTIVITY_TYPE_BY_CHANNEL, textToEmailHtml };
export default DemoOutreachService;
