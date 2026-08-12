import nodemailer from "nodemailer";

const getClientUrl = () => process.env.CLIENT_URL || "http://localhost:3001";

const createTransporter = () =>
  nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_PASSWORD,
    },
  });

const sendEmail = async ({ to, subject, text, testMessageId }) => {
  if (!to) return null;

  if (process.env.NODE_ENV === "test") {
    return {
      accepted: [to],
      messageId: testMessageId || "test-callbackiq-email",
    };
  }

  if (!process.env.GMAIL_ADDRESS || !process.env.GMAIL_PASSWORD) {
    const error = new Error(
      "GMAIL_ADDRESS and GMAIL_PASSWORD are required to send CallBackIQ email.",
    );
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  return createTransporter().sendMail({
    from: `"${process.env.EMAIL_SENDER_NAME || "CallBackIQ"}" <${process.env.GMAIL_ADDRESS}>`,
    to,
    subject,
    text,
  });
};

const sendPasswordResetEmail = async (email, resetToken) => {
  const resetLink = `${getClientUrl()}/reset-password/${resetToken}`;

  const result = await sendEmail({
    to: email,
    subject: "Reset your CallBackIQ password",
    testMessageId: "test-password-reset-email",
    text: `Click this link to reset your CallBackIQ password: ${resetLink}

This link expires in 30 minutes.
If you did not request this password reset, you can ignore this email.`,
  });

  if (process.env.NODE_ENV === "test" && result) {
    result.resetToken = resetToken;
  }

  return result;
};

export const sendTrialWelcomeEmail = async ({
  email,
  businessName,
  trialEndsAt,
}) =>
  sendEmail({
    to: email,
    subject: "Your 14-day CallBackIQ trial is active",
    testMessageId: "test-trial-welcome-email",
    text: `${businessName || "Your business"} is now on a 14-day CallBackIQ trial.

Your trial ends ${new Date(trialEndsAt).toLocaleDateString("en-US")}.
Your CallBackIQ tracking number is being prepared so you can test the real call-recovery workflow.

Finish setup: ${getClientUrl()}/setup
Manage billing: ${getClientUrl()}/billing`,
  });

export const sendTrialReminderEmail = async ({
  email,
  businessName,
  trialEndsAt,
  daysRemaining,
}) =>
  sendEmail({
    to: email,
    subject: `Your CallBackIQ trial ends in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
    testMessageId: `test-trial-${daysRemaining}d-reminder-email`,
    text: `${businessName || "Your business"} has ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining in its CallBackIQ trial.

Trial end date: ${new Date(trialEndsAt).toLocaleDateString("en-US")}

Add a payment method or choose your plan before the trial ends to keep call recovery active and retain your tracking number.

Manage billing: ${getClientUrl()}/billing`,
  });

export const sendTrialExpiredEmail = async ({ email, businessName }) =>
  sendEmail({
    to: email,
    subject: "Your CallBackIQ trial has ended",
    testMessageId: "test-trial-expired-email",
    text: `${businessName || "Your business"}'s CallBackIQ trial has ended.

Automated call recovery is paused. Your tracking number is held for a limited grace period before release.

Reactivate CallBackIQ: ${getClientUrl()}/billing`,
  });

export const sendTrackingNumberReleasedEmail = async ({
  email,
  businessName,
}) =>
  sendEmail({
    to: email,
    subject: "Your CallBackIQ trial number was released",
    testMessageId: "test-trial-number-released-email",
    text: `${businessName || "Your business"}'s trial tracking number has been released after the post-trial grace period.

You can still subscribe to CallBackIQ. A new tracking number will be provisioned when eligible access is restored.

Subscribe: ${getClientUrl()}/billing`,
  });

export default sendPasswordResetEmail;
