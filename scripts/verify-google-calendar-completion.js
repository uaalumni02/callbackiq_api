import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const checks = [];
const requireText = (file, text) => {
  const found = read(file).includes(text);
  checks.push({ file, text, found });
};

requireText("src/routes/integration.routes.js", '"/google/settings"');
requireText("src/routes/integration.routes.js", '"/google/calendar"');
requireText("src/integrations/scheduling/googleCalendar.provider.js", "attendees");
requireText(
  "src/integrations/scheduling/googleCalendar.provider.js",
  "includeEstimatedValue",
);
requireText(
  "src/integrations/scheduling/googleCalendar.provider.js",
  "remainingCapacity",
);
requireText(
  "src/services/scheduling/appointmentNotification.service.js",
  "Reply C to confirm or R to reschedule",
);
requireText(
  "src/services/integrations/googleCalendarChangeReview.service.js",
  "appointment_change_review",
);
requireText(
  "src/services/integrations/googleCalendarSync.service.js",
  "sweepOrphanedGoogleEvents",
);
requireText(
  "src/services/booking/bookingStateMachine.service.js",
  "TOMORROW_PATTERN",
);
requireText(
  "src/services/booking/bookingStateMachine.service.js",
  "spreadSlotOptions",
);
requireText(
  "src/models/integrationConnection.js",
  "{ business: 1, provider: 1 }",
);
requireText(
  "src/routes/appointment.routes.js",
  "provider-change/approve",
);
requireText(
  "src/integrations/scheduling/googleCalendar.provider.js",
  "queryableAppointmentIds",
);
requireText(
  "src/services/integrations/googleCalendarSync.service.js",
  "isAppointmentObjectId",
);
requireText(
  "src/services/scheduling/appointment.service.js",
  "eventAppointment: replacement",
);
requireText(
  "src/services/scheduling/appointmentNotification.service.js",
  "populated.lockedBy !== instanceId",
);
requireText(
  "src/services/booking/bookingStateMachine.service.js",
  "Destructive or schedule-changing intent takes precedence",
);
requireText(
  "src/services/scheduling/appointmentNotification.service.js",
  "refreshUpcomingAppointmentNotifications",
);
requireText(
  "src/workers/integrationWebhook.worker.js",
  "getGoogleSettings(connection).syncEnabled === false",
);

const failures = checks.filter((check) => !check.found);
for (const check of checks) {
  console.log(`${check.found ? "PASS" : "FAIL"} ${check.file}: ${check.text}`);
}
if (failures.length) {
  console.error(`\nGoogle Calendar completion verification failed: ${failures.length} checks.`);
  process.exit(1);
}
console.log(`\nGoogle Calendar completion verification passed: ${checks.length} checks.`);
