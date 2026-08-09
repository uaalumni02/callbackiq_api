import nodemailer from "nodemailer";

const clean = (value) => String(value || "").trim();

const getConfig = () => {
  const gmailAddress = clean(process.env.GMAIL_ADDRESS);

  return {
    gmailAddress,
    gmailPassword: clean(process.env.GMAIL_PASSWORD),
    senderName: clean(process.env.EMAIL_SENDER_NAME) || "CallBackIQ",
    // For the current CallBackIQ setup, the Gmail inbox is also the default
    // destination for internal demo alerts. This can still be overridden later.
    adminEmail: clean(process.env.DEMO_NOTIFICATION_EMAIL) || gmailAddress,
    publicAppUrl: clean(
      process.env.PUBLIC_APP_URL ||
        process.env.FRONTEND_URL ||
        "http://localhost:3001",
    ).replace(/\/+$/, ""),
  };
};

const formatDemoTime = (demo) => {
  if (!demo?.scheduledAt) return "Not scheduled";

  const timeZone =
    demo.timezone || process.env.DEMO_TIMEZONE || "America/New_York";

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(demo.scheduledAt));
};

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const buildFrom = ({ senderName, gmailAddress }) =>
  `${senderName} <${gmailAddress}>`;

class DemoNotificationService {
  static isConfigured() {
    const config = getConfig();
    return Boolean(config.gmailAddress && config.gmailPassword);
  }

  static async send({ to, subject, html }) {
    const config = getConfig();
    if (!config.gmailAddress || !config.gmailPassword || !to) return false;

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: config.gmailAddress,
          pass: config.gmailPassword,
        },
      });

      await transporter.sendMail({
        from: buildFrom(config),
        to,
        subject,
        html,
      });

      return true;
    } catch (error) {
      // Demo booking must remain available even if email delivery is degraded.
      console.error("Demo notification email failed:", error);
      return false;
    }
  }

  static async notifyAdminNewRequest(demo) {
    const { adminEmail } = getConfig();
    if (!adminEmail) return false;

    return this.send({
      to: adminEmail,
      subject: `New CallBackIQ demo request — ${demo.businessName}`,
      html: `
        <h2>New demo request</h2>
        <p><strong>${escapeHtml(demo.businessName)}</strong></p>
        <p>${escapeHtml(demo.fullName)} — ${escapeHtml(demo.email)}</p>
        ${demo.phone ? `<p>${escapeHtml(demo.phone)}</p>` : ""}
        <p>Industry: ${escapeHtml(demo.businessType || "Not provided")}</p>
        <p>Monthly calls: ${escapeHtml(demo.monthlyCallVolume || "Not provided")}</p>
        ${demo.message ? `<p>${escapeHtml(demo.message)}</p>` : ""}
      `,
    });
  }

  static async notifyScheduled(demo, bookingToken) {
    const config = getConfig();
    const manageUrl =
      bookingToken && demo?._id
        ? `${config.publicAppUrl}/book-demo?request=${encodeURIComponent(
            String(demo._id),
          )}&token=${encodeURIComponent(bookingToken)}`
        : "";

    const prospect = this.send({
      to: demo.email,
      subject: "Your CallBackIQ demo is booked",
      html: `
        <h2>Your CallBackIQ demo is booked.</h2>
        <p><strong>${escapeHtml(formatDemoTime(demo))}</strong></p>
        <p>We’ll focus the walkthrough on how Voice AI and SMS recover unanswered calls, qualify opportunities, and move customers toward booking or human follow-up.</p>
        ${
          demo.meetingUrl
            ? `<p><a href="${escapeHtml(demo.meetingUrl)}">Join demo</a></p>`
            : ""
        }
        ${
          manageUrl
            ? `<p><a href="${escapeHtml(manageUrl)}">Reschedule or cancel</a></p>`
            : ""
        }
      `,
    });

    const admin = config.adminEmail
      ? this.send({
          to: config.adminEmail,
          subject: `Demo scheduled — ${demo.businessName}`,
          html: `
            <h2>Demo scheduled</h2>
            <p><strong>${escapeHtml(demo.businessName)}</strong></p>
            <p>${escapeHtml(demo.fullName)} — ${escapeHtml(demo.email)}</p>
            <p><strong>${escapeHtml(formatDemoTime(demo))}</strong></p>
            ${
              demo.meetingUrl
                ? `<p><a href="${escapeHtml(demo.meetingUrl)}">Join demo</a></p>`
                : ""
            }
          `,
        })
      : Promise.resolve(false);

    return Promise.allSettled([prospect, admin]);
  }

  static async notifyCancelled(demo) {
    const { adminEmail } = getConfig();

    const prospect = this.send({
      to: demo.email,
      subject: "Your CallBackIQ demo was cancelled",
      html: `
        <h2>Your demo was cancelled.</h2>
        <p>If you’d like to choose another time, return to the CallBackIQ Book a Demo page.</p>
      `,
    });

    const admin = adminEmail
      ? this.send({
          to: adminEmail,
          subject: `Demo cancelled — ${demo.businessName}`,
          html: `
            <h2>Demo cancelled</h2>
            <p><strong>${escapeHtml(demo.businessName)}</strong></p>
            <p>${escapeHtml(demo.fullName)} — ${escapeHtml(demo.email)}</p>
          `,
        })
      : Promise.resolve(false);

    return Promise.allSettled([prospect, admin]);
  }
}

export { formatDemoTime, getConfig };
export default DemoNotificationService;
