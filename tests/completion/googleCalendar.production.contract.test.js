import fs from "fs";
import path from "path";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("Google Calendar production contract", () => {
  test("keeps one business-scoped connection per provider", () => {
    const model = read("src/models/integrationConnection.js");
    expect(model).toContain("{ business: 1, provider: 1 }");
    expect(model).toContain("reconnect_required");
    expect(model).toContain("providerAccountEmail");
    expect(model).toContain("availabilityCalendarIds");
    expect(model).toContain("select: false");
  });

  test("uses one-time signed state and encrypted OAuth credentials", () => {
    const service = read(
      "src/services/integrations/googleCalendarConnection.service.js",
    );
    expect(service).toContain("timingSafeEqual");
    expect(service).toContain("oauthStateHash");
    expect(service).toContain("GOOGLE_OAUTH_STATE_REPLAYED");
    expect(service).toContain("encryptSecret(tokens.access_token)");
    expect(service).toContain("refreshTokenEncrypted");
    expect(service).toContain("GOOGLE_RECONNECT_REQUIRED");
  });

  test("checks every selected availability calendar and uses deterministic events", () => {
    const provider = read(
      "src/integrations/scheduling/googleCalendar.provider.js",
    );
    expect(read("src/integrations/scheduling/googleAvailabilitySnapshot.js")).toContain("availabilityCalendarIds.map");
    expect(read("src/integrations/scheduling/googleFinalAvailability.js")).toContain("forceFresh: true");
    expect(provider).toContain("deterministicEventId");
    expect(provider).toContain('visibility: "private"');
    expect(provider).toContain("callbackiqBusinessId");
    expect(provider).toContain("allowStatuses: [404, 410]");
  });

  test("exposes backward-compatible routes and mounts raw webhooks", () => {
    const routes = read("src/routes/integration.routes.js");
    const app = read("src/app.js");
    expect(routes).toContain('router.patch(\n  "/google/calendar"');
    expect(routes).toContain('router.post(\n  "/google/calendar"');
    expect(routes).toContain('"/google/sync"');
    expect(routes).toContain('"/google/watch"');
    expect(routes).toContain('"/google/webhook"');
    expect(app).toContain(
      'app.use("/api/integration-webhooks", integrationWebhookRoutes)',
    );
  });

  test("continues to route confirmed appointments through the provider-neutral engine", () => {
    const appointmentService = read(
      "src/services/scheduling/appointment.service.js",
    );
    expect(appointmentService).toContain("commands.confirmation.confirm.apply(this, args)");
    expect(appointmentService).toContain("commands.cancellation.cancel.apply(this, args)");
    expect(appointmentService).toContain("commands.reschedule.reschedule.apply(this, args)");
    expect(require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "src/services/scheduling/commands/confirm-1.js"), "utf8")).toContain("SchedulingProviderFactory.getProvider(business)");
    expect(require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "src/services/scheduling/commands/cancel-1.js"), "utf8")).toContain("InterventionService.integrationFailure");
    expect(require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "src/services/scheduling/reschedule/recovery.js"), "utf8")).toContain("InterventionService.integrationFailure");
    expect(appointmentService + "\n" + require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "src/services/scheduling/commands/confirm-1.js"), "utf8")).toContain(
      "SchedulingProviderFactory.getProvider(business)",
    );
    expect(appointmentService).toContain("exactSlotAvailable");
    expect(appointmentService).toContain("idempotencyKey");
    expect(appointmentService + "\n" + require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "src/services/scheduling/commands/cancel-1.js"), "utf8") + "\n" + require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "src/services/scheduling/reschedule/recovery.js"), "utf8")).toContain("InterventionService.integrationFailure");
  });
});
