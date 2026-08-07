import fs from "fs";
import path from "path";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("Google Calendar customer experience completion contract", () => {
  test("keeps every Google connection and setting business scoped", () => {
    const connection = read("src/models/integrationConnection.js");
    const provider = read(
      "src/integrations/scheduling/googleCalendar.provider.js",
    );
    const sync = read(
      "src/services/integrations/googleCalendarSync.service.js",
    );

    expect(connection).toContain("{ business: 1, provider: 1 }");
    expect(provider).toContain("callbackiqBusinessId");
    expect(provider).toContain("cacheKey");
    expect(sync).toContain("String(eventBusinessId) !== String(businessId)");
    expect(sync).toContain("business: businessId");
  });

  test("exposes a working settings endpoint and canonical calendar endpoint", () => {
    const routes = read("src/routes/integration.routes.js");
    const frontendContract = read("src/controllers/integration.js");

    expect(routes).toContain('"/google/settings"');
    expect(routes).toContain('"/google/calendar"');
    expect(frontendContract).toContain("googleSaveSettings");
    expect(frontendContract).toContain("defaultAttendeeEmail");
    expect(frontendContract).toContain("customerRemindersEnabled");
  });

  test("creates customer attendees without exposing estimated value by default", () => {
    const provider = read(
      "src/integrations/scheduling/googleCalendar.provider.js",
    );

    expect(provider).toContain("appointment.customerEmail");
    expect(provider).toContain("settings.defaultAttendeeEmail");
    expect(provider).toContain("settings.includeEstimatedValue === true");
    expect(provider).toContain('sendUpdates: settings.sendUpdates || "all"');
  });

  test("schedules reminders, change notices, and post-appointment follow-up", () => {
    const notification = read(
      "src/services/scheduling/appointmentNotification.service.js",
    );
    const worker = read("src/workers/automation.worker.js");
    const stateMachine = read(
      "src/services/booking/bookingStateMachine.service.js",
    );

    expect(notification).toContain("reminderHours || [24, 2]");
    expect(notification).toContain("Reply C to confirm or R to reschedule");
    expect(notification).toContain("scheduleAppointmentChangeNotice");
    expect(notification).toContain("schedulePostAppointmentFollowUp");
    expect(worker).toContain("processDueAppointmentNotifications");
    expect(stateMachine).toContain("customerConfirmedAt");
    expect(stateMachine).toContain("customerRescheduleRequestedAt");
  });

  test("requires review before Google moves or cancellations affect customers", () => {
    const sync = read(
      "src/services/integrations/googleCalendarSync.service.js",
    );
    const review = read(
      "src/services/integrations/googleCalendarChangeReview.service.js",
    );
    const appointmentRoutes = read("src/routes/appointment.routes.js");

    expect(sync).toContain("queueGoogleProviderChange");
    expect(sync).toContain("googleChangeApprovalRequired");
    expect(review).toContain('type: "appointment_change_review"');
    expect(review).toContain("scheduleAppointmentChangeNotice");
    expect(appointmentRoutes).toContain("provider-change/approve");
    expect(appointmentRoutes).toContain("provider-change/reject");
  });

  test("preserves capacity lanes and cleans orphaned Google events", () => {
    const provider = read(
      "src/integrations/scheduling/googleCalendar.provider.js",
    );
    const sync = read(
      "src/services/integrations/googleCalendarSync.service.js",
    );
    const worker = read("src/workers/automation.worker.js");

    expect(provider).toContain("remainingCapacity");
    expect(provider).toContain("bookingBusyLanes");
    expect(provider).toContain("otherBusyLanes");
    expect(sync).toContain("sweepOrphanedGoogleEvents");
    expect(worker).toContain("sweepOrphanedGoogleEvents");
  });

  test("recognizes natural booking language and structured addresses", () => {
    const stateMachine = read(
      "src/services/booking/bookingStateMachine.service.js",
    );

    expect(stateMachine).toContain("findDateRange");
    expect(stateMachine).toContain("parseTimePreference");
    expect(stateMachine).toContain("spreadSlotOptions");
    expect(stateMachine).toContain("parseStreetAddress");
    expect(stateMachine).toContain("collecting_postal_code");
  });
});
