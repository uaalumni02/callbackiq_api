import twilio from "twilio";

const client = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid) throw new Error("TWILIO_ACCOUNT_SID is required.");
  if (apiKey && apiSecret) return twilio(apiKey, apiSecret, { accountSid });
  if (authToken) return twilio(accountSid, authToken);
  throw new Error("Twilio API credentials are required.");
};

export const ensureAccountUsageTriggers = async ({
  callbackUrl,
  dailyVoiceDollars,
  monthlyVoiceDollars,
}) => {
  const twilioClient = client();
  const requested = [
    {
      friendlyName: "CallBackIQ daily voice spend guard",
      recurring: "daily",
      triggerBy: "price",
      triggerValue: String(dailyVoiceDollars),
      usageCategory: "calls",
    },
    {
      friendlyName: "CallBackIQ monthly voice spend guard",
      recurring: "monthly",
      triggerBy: "price",
      triggerValue: String(monthlyVoiceDollars),
      usageCategory: "calls",
    },
  ];

  const existing = await twilioClient.usage.triggers.list({ limit: 100 });
  const results = [];
  for (const item of requested) {
    const found = existing.find(
      (trigger) => trigger.friendlyName === item.friendlyName,
    );
    if (found) {
      results.push(found);
      continue;
    }
    results.push(
      await twilioClient.usage.triggers.create({
        ...item,
        callbackUrl,
        callbackMethod: "POST",
      }),
    );
  }
  return results;
};

export default { ensureAccountUsageTriggers };
