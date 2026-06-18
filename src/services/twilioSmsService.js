import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

export const sendSms = async ({ to, from, body }) => {
  return await client.messages.create({
    to,
    from,
    body,
  });
};
