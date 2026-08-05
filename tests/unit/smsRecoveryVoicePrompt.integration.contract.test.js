import fs from "fs";
import path from "path";

const controllerPath = path.resolve("src/controllers/twilio.js");
const webhookServicePath = path.resolve(
  "src/services/twilioSmsWebhook.service.js",
);

describe("Twilio SMS-recovery prompt wiring", () => {
  test("delegates voice recovery and tracks actual SMS delivery status", () => {
    const controller = fs.readFileSync(controllerPath, "utf8");
    const service = fs.readFileSync(webhookServicePath, "utf8");

    expect(controller).toMatch(/handleSmsRecoveryVoiceWebhook/);
    expect(service).toMatch(/buildSmsRecoveryVoicePrompt/);
    expect(service).toMatch(/let\s+smsStatus\s*=\s*smsEnabled/);
    expect(service).toMatch(/smsStatus\s*=\s*sentResult\?\.suppressed/);
    expect(service).toMatch(/businessName:\s*business\.businessName/);
    expect(service).toMatch(/smsEnabled,\s*\n\s*smsStatus,/);
    expect(service).not.toContain("Thank you. The business has been notified.");
  });
});
