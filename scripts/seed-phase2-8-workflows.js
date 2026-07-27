import "dotenv/config";

import connectDB from "../src/db/connection.js";
import Business from "../src/models/business.js";
import AutomationWorkflow from "../src/models/automationWorkflow.js";

const presets = [
  {
    name: "Missed-call no response",
    trigger: "missed_call_no_response",
    maximumAttempts: 2,
    steps: [
      {
        delayMinutes: 120,
        action: "send_sms",
        template:
          "Hi {{lead.customerName}}, do you still need help from {{business.businessName}}? Reply with the service details and we’ll help with next steps.",
      },
      {
        delayMinutes: 1440,
        action: "send_sms",
        template:
          "Just checking in one final time. Reply here if you still need service, or reply STOP to opt out.",
      },
    ],
  },
  {
    name: "Incomplete qualification",
    trigger: "incomplete_qualification",
    maximumAttempts: 1,
    steps: [
      {
        delayMinutes: 180,
        action: "send_sms",
        template:
          "To help the team respond, please reply with the service you need and the service address.",
      },
    ],
  },
  {
    name: "Appointment offered, not selected",
    trigger: "appointment_offered_not_selected",
    maximumAttempts: 1,
    steps: [
      {
        delayMinutes: 60,
        action: "send_sms",
        template:
          "Would you like one of the appointment times I shared, or should I check another day?",
      },
    ],
  },
  {
    name: "Canceled appointment recovery",
    trigger: "canceled_appointment_recovery",
    maximumAttempts: 1,
    steps: [
      {
        delayMinutes: 120,
        action: "send_sms",
        template:
          "Would you like help choosing a new appointment time? Reply with the day that works best.",
      },
    ],
  },
];

const businessId = String(process.argv[2] || "").trim();

if (!businessId) {
  console.error("Usage: npm run seed:phase2-8 -- <businessObjectId>");
  process.exit(1);
}

await connectDB();
const business = await Business.findById(businessId);

if (!business) {
  console.error("Business not found.");
  process.exit(1);
}

for (const preset of presets) {
  await AutomationWorkflow.updateOne(
    { business: business._id, name: preset.name },
    {
      $setOnInsert: {
        business: business._id,
        ...preset,
        enabled: false,
        quietHoursStart: "20:00",
        quietHoursEnd: "08:00",
        minimumIntervalMinutes: 120,
        allowedDays: [1, 2, 3, 4, 5, 6],
        templateApprovalRequired: true,
        templatesApproved: false,
      },
    },
    { upsert: true },
  );
}

console.log(
  `Created or preserved ${presets.length} disabled workflow presets for ${business.businessName}.`,
);
process.exit(0);
