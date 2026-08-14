import "dotenv/config";
import twilio from "twilio";

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const client = twilio(required("TWILIO_ACCOUNT_SID"), required("TWILIO_AUTH_TOKEN"));
const username = required("A2P_EVENT_STREAM_USERNAME");
const password = required("A2P_EVENT_STREAM_PASSWORD");
const explicitUrl = String(process.env.A2P_EVENT_STREAM_URL || "").trim();
const base = String(process.env.API_PUBLIC_URL || process.env.TWILIO_WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "");
const destination = explicitUrl || (base ? `${base}/api/a2p-events/twilio` : "");
if (!destination) throw new Error("Set A2P_EVENT_STREAM_URL or API_PUBLIC_URL/TWILIO_WEBHOOK_BASE_URL.");

const url = new URL(destination);
if (url.protocol !== "https:") throw new Error("A2P Event Streams webhook must use HTTPS.");
url.username = username;
url.password = password;

const sinkDescription = "CallBackIQ A2P Compliance Webhook";
const subscriptionDescription = "CallBackIQ A2P Compliance Events";
const eventTypes = [
  "com.twilio.messaging.compliance.brand-registration.brand-registered",
  "com.twilio.messaging.compliance.brand-registration.brand-failure",
  "com.twilio.messaging.compliance.brand-registration.brand-verified",
  "com.twilio.messaging.compliance.brand-registration.brand-unverified",
  "com.twilio.messaging.compliance.brand-registration.brand-vetted-verified",
  "com.twilio.messaging.compliance.brand-registration.brand-secondary-vetting-failure",
  "com.twilio.messaging.compliance.campaign-registration.campaign-submitted",
  "com.twilio.messaging.compliance.campaign-registration.campaign-failure",
  "com.twilio.messaging.compliance.campaign-registration.campaign-approved",
  "com.twilio.messaging.compliance.number-registration.failed",
  "com.twilio.messaging.compliance.number-registration.pending",
  "com.twilio.messaging.compliance.number-registration.successful",
];

const desiredSinkConfiguration = {
  destination: url.toString(),
  method: "POST",
};
const sinks = await client.events.v1.sinks.list({ limit: 200 });
let sink = sinks.find((item) => item.description === sinkDescription);
if (!sink) {
  sink = await client.events.v1.sinks.create({
    description: sinkDescription,
    sinkConfiguration: desiredSinkConfiguration,
    sinkType: "webhook",
  });
} else {
  const currentDestination = String(
    sink?.sinkConfiguration?.destination || "",
  );
  if (currentDestination !== desiredSinkConfiguration.destination) {
    sink = await client.events.v1.sinks(sink.sid).update({
      sinkConfiguration: desiredSinkConfiguration,
    });
  }
}

// A newly created webhook sink can spend a short period validating before it
// becomes eligible for a Subscription. Poll briefly so this one-time setup
// command succeeds without requiring the operator to guess when to rerun it.
for (let attempt = 0; attempt < 30 && sink.status !== "active"; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  sink = await client.events.v1.sinks(sink.sid).fetch();
  if (sink.status === "failed") {
    throw new Error(`Twilio Event Streams sink validation failed for ${sink.sid}.`);
  }
}
if (sink.status !== "active") {
  throw new Error(`Twilio Event Streams sink ${sink.sid} is not active yet. Re-run this command after the sink becomes active.`);
}

const subscriptions = await client.events.v1.subscriptions.list({ limit: 200 });
let subscription = subscriptions.find((item) => item.description === subscriptionDescription);
if (!subscription) {
  subscription = await client.events.v1.subscriptions.create({
    description: subscriptionDescription,
    sinkSid: sink.sid,
    // Schema v1 exists for every A2P event used here and provides a stable
    // common payload. The receiver also accepts newer field spellings.
    types: eventTypes.map((type) => ({ type, schemaVersion: 1 })),
  });
}

console.log(JSON.stringify({
  ok: true,
  sinkSid: sink.sid,
  subscriptionSid: subscription.sid,
  eventTypes: eventTypes.length,
  destinationHost: url.host,
}, null, 2));
