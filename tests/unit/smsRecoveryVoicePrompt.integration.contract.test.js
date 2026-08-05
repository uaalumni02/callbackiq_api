import fs from "fs";
import path from "path";

const controllerPath = path.resolve("src/controllers/twilio.js");

describe("Twilio SMS-recovery prompt wiring", () => {
  test("uses the business-aware prompt and tracks actual SMS delivery", () => {
    const source = fs.readFileSync(controllerPath, "utf8");

    expect(source).toMatch(/buildSmsRecoveryVoicePrompt/);
    expect(source).toMatch(/smsRecoveryStatus\s*=\s*missedCallSmsEnabled/);
    expect(source).toMatch(/smsRecoveryStatus\s*=\s*["']suppressed["']/);
    expect(source).toMatch(/smsRecoveryStatus\s*=\s*["']sent["']/);
    expect(source).toMatch(/businessName:\s*business\.businessName/);
    expect(source).toMatch(/smsEnabled:\s*missedCallSmsEnabled/);
    expect(source).toMatch(/smsStatus:\s*smsRecoveryStatus/);
    expect(source).not.toContain("Thank you. The business has been notified.");
  });
});
