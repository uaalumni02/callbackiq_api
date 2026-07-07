import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const sendPasswordResetEmail = async (email, resetToken) => {
  const clientUrl = process.env.CLIENT_URL || "http://localhost:3001";
  const resetLink = `${clientUrl}/reset-password/${resetToken}`;

  return await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "CallBackIQ <onboarding@resend.dev>",
    to: email,
    subject: "Reset your CallBackIQ password",
    text: `Click this link to reset your CallBackIQ password: ${resetLink}

This link expires in 30 minutes.

If you did not request this password reset, you can ignore this email.`,
  });
};

export default sendPasswordResetEmail;
