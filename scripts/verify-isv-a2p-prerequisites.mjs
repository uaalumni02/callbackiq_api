import "dotenv/config";
import twilio from "twilio";

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const client = twilio(required("TWILIO_ACCOUNT_SID"), required("TWILIO_AUTH_TOKEN"));
const primarySid = required("TWILIO_PRIMARY_CUSTOMER_PROFILE_SID");
required("A2P_NOTIFICATION_EMAIL");
required("A2P_EVENT_STREAM_USERNAME");
required("A2P_EVENT_STREAM_PASSWORD");

const profile = await client.trusthub.v1.customerProfiles(primarySid).fetch();
const status = String(profile.status || "").toLowerCase();
if (!status.includes("approved")) {
  throw new Error(`Primary Customer Profile ${primarySid} is not approved (status: ${profile.status || "unknown"}).`);
}

console.log(JSON.stringify({
  ok: true,
  primaryCustomerProfileSid: primarySid,
  primaryCustomerProfileStatus: profile.status,
  notificationEmailConfigured: true,
  eventStreamCredentialsConfigured: true,
  note: "Confirm the approved Primary Customer Profile Business Identity is ISV Reseller or Partner in Twilio Trust Hub.",
}, null, 2));
