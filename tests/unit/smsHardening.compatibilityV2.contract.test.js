import fs from "fs";
import path from "path";

const apiRoot = path.resolve(process.cwd());
const source = (relative) =>
  fs.readFileSync(path.join(apiRoot, relative), "utf8");

describe("SMS hardening delivery-aware SMS compatibility v2", () => {
  test("keeps centralized send-window and phone validation in production", () => {
    const smsService = source("src/services/twilioSmsService.js");

    expect(smsService).toMatch(/evaluateSmsSendWindow/);
    expect(smsService).toMatch(/normalizeSmsPhone/);
    expect(smsService).toMatch(/outside_send_window|sendWindow\.reason/);
  });

  test("keeps dashboard metrics tied to provider-accepted delivery records", () => {
    const dbSource = source("src/db/db.js");

    expect(dbSource).toMatch(/providerMessageId/);
    expect(dbSource).toMatch(/smsDelivered/);
    expect(dbSource).toMatch(/smsFailed/);
    expect(dbSource).toMatch(/smsSegments/);
  });

  test("keeps canonical E.164 lead identity normalization", () => {
    const leadSource = source("src/models/lead.js");

    expect(leadSource).toMatch(/normalizePhoneToE164/);
    expect(leadSource).toMatch(/phoneLookup/);
  });
});
