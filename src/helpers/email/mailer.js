import { emailConfiguration } from './emailConfiguration.js';
import nodemailer from "nodemailer";

const getClientUrl = () => process.env.CLIENT_URL || "http://localhost:3001";

const createTransporter = () => nodemailer.createTransport(emailConfiguration().transport);

const sendEmail = async ({ to, subject, text, testMessageId, messageId }) => {
  if (!to) return null;

  if (process.env.NODE_ENV === "test") {
    return {
      accepted: [to],
      messageId: testMessageId || "test-callbackiq-email",
    };
  }

  if (!emailConfiguration().configured) {
    const error = new Error(
      "Configure SMTP credentials and a sender address, or the existing Gmail credentials, to send email.",
    );
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  return createTransporter().sendMail({
    from: `"${process.env.EMAIL_SENDER_NAME || "MeekCall"}" <${emailConfiguration().from}>`,
    messageId,
    to,
    subject,
    text,
  });
};

const sendPasswordResetEmail = async (email, resetToken) => {
  const resetLink = `${getClientUrl()}/reset-password/${resetToken}`;

  const result = await sendEmail({
    to: email,
    subject: "Reset your MeekCall password",
    testMessageId: "test-password-reset-email",
    text: `Click this link to reset your MeekCall password: ${resetLink}

This link expires in 30 minutes.
If you did not request this password reset, you can ignore this email.`,
  });

  if (process.env.NODE_ENV === "test" && result) {
    result.resetToken = resetToken;
  }

  return result;
};

export const sendEmailVerificationEmail = async ({ email, token }) =>
  sendEmail({
    to: email,
    subject: "Verify your MeekCall business email",
    testMessageId: "test-email-verification",
    text: `Verify your business email before activating your MeekCall free trial.

Verify email: ${getClientUrl()}/verify-email?token=${encodeURIComponent(token)}

This verification link expires in 24 hours. If you did not create a MeekCall account, you can ignore this email.`,
  });

export const sendTrialWelcomeEmail = async ({
  email,
  businessName,
  trialEndsAt,
  messageId,
}) =>
  sendEmail({
    to: email,
    subject: "Your 14-day MeekCall trial is active",
    messageId,
    testMessageId: "test-trial-welcome-email",
    text: `${businessName || "Your business"} is now on a 14-day MeekCall trial.

Your trial ends ${new Date(trialEndsAt).toLocaleDateString("en-US")}.
Your MeekCall tracking number is being prepared so you can test the real call-recovery workflow.

Finish setup: ${getClientUrl()}/setup
Manage billing: ${getClientUrl()}/billing`,
  });

export const sendTrialReminderEmail = async ({
  email,
  businessName,
  trialEndsAt,
  daysRemaining,
  messageId,
}) =>
  sendEmail({
    to: email,
    subject: `Your MeekCall trial ends in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
    messageId,
    testMessageId: `test-trial-${daysRemaining}d-reminder-email`,
    text: `${businessName || "Your business"} has ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining in its MeekCall trial.

Trial end date: ${new Date(trialEndsAt).toLocaleDateString("en-US")}

Add a payment method or choose your plan before the trial ends to keep call recovery active and retain your tracking number.

Manage billing: ${getClientUrl()}/billing`,
  });

export const sendTrialExpiredEmail = async ({ email, businessName, messageId }) =>
  sendEmail({
    to: email,
    subject: "Your MeekCall trial has ended",
    messageId,
    testMessageId: "test-trial-expired-email",
    text: `${businessName || "Your business"}'s MeekCall trial has ended.

Automated call recovery is paused. Your tracking number is held for a limited grace period before release.

Reactivate MeekCall: ${getClientUrl()}/billing`,
  });

export const sendTrackingNumberReleasedEmail = async ({
  email,
  businessName,
  messageId,
}) =>
  sendEmail({
    to: email,
    subject: "Your MeekCall trial number was released",
    messageId,
    testMessageId: "test-trial-number-released-email",
    text: `${businessName || "Your business"}'s trial tracking number has been released after the post-trial grace period.

You can still subscribe to MeekCall. A new tracking number will be provisioned when eligible access is restored.

Subscribe: ${getClientUrl()}/billing`,
  });

export default sendPasswordResetEmail;

// Notification content deliberately excludes customer text and contact details.
// Provider acceptance is not proof of inbox delivery or owner acknowledgment.
export const sendStaffReviewEmail = ({ email, businessName, alertId, appointmentId, stage, critical = false }) => {
  const clientUrl = new URL(getClientUrl());
  if (!["https:", "http:"].includes(clientUrl.protocol)) throw new Error("Invalid CLIENT_URL");
  const link = new URL(appointmentId ? "/appointments" : "/intervention-center", clientUrl);
  link.searchParams.set(appointmentId ? "appointmentId" : "alertId", appointmentId || alertId);
  return sendEmail({ to: email,
    subject: critical ? "MeekCall: urgent safety concern reported" : stage === "expired" ? "MeekCall: appointment request needs an availability recheck" : stage === "overdue" ? "MeekCall: staff review is overdue" : "MeekCall: customer request needs review",
    text: critical ? `${businessName || "Your business"} received an urgent safety concern. Review the record immediately: ${link}\n\nA team member may already be responding. MeekCall does not dispatch emergency help.` : `${businessName || "Your business"} has a customer request requiring staff review.\n\nOpen Needs Attention and acknowledge the request: ${link}\n\nThis email does not confirm that anyone has accepted the request or booked an appointment.`,
  });
};
