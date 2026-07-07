import nodemailer from "nodemailer";

const sendPasswordResetEmail = async (email, resetToken) => {
  const clientUrl = process.env.CLIENT_URL || "http://localhost:3001";
  const resetLink = `${clientUrl}/reset-password/${resetToken}`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_PASSWORD,
    },
  });

  return await transporter.sendMail({
    from: `"${process.env.EMAIL_SENDER_NAME || "CallBackIQ"}" <${process.env.GMAIL_ADDRESS}>`,
    to: email,
    subject: "Reset your CallBackIQ password",
    text: `Click this link to reset your CallBackIQ password: ${resetLink}

This link expires in 30 minutes.

If you did not request this password reset, you can ignore this email.`,
  });
};

export default sendPasswordResetEmail;
