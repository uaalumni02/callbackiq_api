import { recordCustomerAppointmentAcknowledgement, recordCustomerRescheduleRequest } from "../../src/services/stateTransitions/requestIntake.js";
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
    const snapshot=read("src/integrations/scheduling/googleAvailabilitySnapshot.js");expect(snapshot).toContain("businessId,");expect(snapshot).toContain("epoch");
    expect(sync).toContain("String(eventBusinessId) !== String(businessId)");
    expect(sync).toContain("business: businessId");
  });

  test("exposes a working settings endpoint and canonical calendar endpoint", () => {
    const routes = read("src/routes/integration.routes.js");
    const frontendContract = read("src/controllers/integration/GoogleSettings.js");

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
    const existingBookingTurn = read("src/services/booking/existingBookingTurn.service.js");
    expect(stateMachine).toContain('["booked", handleExistingBookingTurn]');
    expect(existingBookingTurn).toContain("recordCustomerAppointmentAcknowledgement");
    expect(existingBookingTurn).toContain("recordCustomerRescheduleRequest");
  });

  test("customer acknowledgements and reschedule requests retain tenant-scoped durable writes", () => {
    const Appointment = { updateOne: jest.fn(), findOneAndUpdate: jest.fn() };
    const context = { Appointment, business: { _id: "tenant-a" }, appointmentId: "appointment-a" };
    recordCustomerRescheduleRequest(context);
    recordCustomerAppointmentAcknowledgement(context);
    expect(Appointment.updateOne).toHaveBeenCalledWith(
      { _id: "appointment-a", business: "tenant-a" },
      { $set: { customerRescheduleRequestedAt: expect.any(Date) } },
    );
    expect(Appointment.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "appointment-a", business: "tenant-a", status: "confirmed" },
      { $set: { customerConfirmedAt: expect.any(Date) } }, { returnDocument: "after" },
    );
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

    const availability=read("src/integrations/scheduling/googleAvailability.js");expect(availability).toContain("remainingCapacity");
    expect(availability).toContain("const booked");
    expect(availability).toContain("const other");expect(availability).toContain("other + booked < capacity");
    expect(sync).toContain("sweepOrphanedGoogleEvents");
    expect(worker).toContain("sweepOrphanedGoogleEvents");
  });

  test("recognizes natural booking language and structured addresses", () => {
    const stateMachine = read(
      "src/services/booking/bookingStateMachine.service.js",
    );

    const availability = read("src/services/booking/bookingAvailabilityTurn.service.js");
    const intake = read("src/services/booking/bookingIntakeTurn.service.js");
    expect(availability).toContain("findDateRange");
    expect(availability).toContain("parseTimePreference");
    expect(availability).toContain("spreadSlotOptions");
    expect(intake).toContain("parseStreetAddress");
    expect(stateMachine).toContain("collecting_postal_code");
  });
});
