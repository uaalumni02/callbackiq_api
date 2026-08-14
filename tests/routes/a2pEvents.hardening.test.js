import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import app from "../../src/app.js";
import { markComplianceEvent } from "../../src/services/a2pCustomerOnboarding.service.js";

jest.mock("../../src/services/a2pCustomerOnboarding.service.js", () => ({
  __esModule: true,
  markComplianceEvent: jest.fn(async () => null),
}));

const fixture = () =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "tests/fixtures/providers/a2p/number-registration-succeeded.json",
      ),
      "utf8",
    ),
  );

describe("A2P Event Streams endpoint hardening", () => {
  beforeAll(() => {
    process.env.A2P_EVENT_STREAM_USERNAME = "ci-a2p-user";
    process.env.A2P_EVENT_STREAM_PASSWORD = "ci-a2p-pass";
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects missing or incorrect Basic authentication", async () => {
    const missing = await request(app)
      .post("/api/a2p-events/twilio")
      .send(fixture());
    expect(missing.status).toBe(401);

    const wrong = await request(app)
      .post("/api/a2p-events/twilio")
      .auth("ci-a2p-user", "wrong-password")
      .send(fixture());
    expect(wrong.status).toBe(401);
    expect(markComplianceEvent).not.toHaveBeenCalled();
  });

  test("accepts Twilio CloudEvents arrays and forwards only compliance events", async () => {
    const payload = [
      ...fixture(),
      {
        specversion: "1.0",
        type: "com.example.unrelated.event",
        data: { ignored: true },
      },
    ];

    const res = await request(app)
      .post("/api/a2p-events/twilio")
      .auth(
        process.env.A2P_EVENT_STREAM_USERNAME,
        process.env.A2P_EVENT_STREAM_PASSWORD,
      )
      .send(payload);

    expect(res.status).toBe(204);
    expect(markComplianceEvent).toHaveBeenCalledTimes(1);
    expect(markComplianceEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "com.twilio.messaging.compliance.number-registration.successful",
      data: expect.objectContaining({
        campaignsid: "CM11111111111111111111111111111111",
        messagingservicesid: "MG11111111111111111111111111111111",
        phonenumbersid: "PN11111111111111111111111111111111",
        externalstatus: "registered",
      }),
    }));
  });

  test("accepts a single provider event object, not only an array", async () => {
    const [event] = fixture();
    const res = await request(app)
      .post("/api/a2p-events/twilio")
      .auth(
        process.env.A2P_EVENT_STREAM_USERNAME,
        process.env.A2P_EVENT_STREAM_PASSWORD,
      )
      .send(event);

    expect(res.status).toBe(204);
    expect(markComplianceEvent).toHaveBeenCalledTimes(1);
  });

  test("fails closed with 500 when compliance processing throws", async () => {
    markComplianceEvent.mockRejectedValueOnce(new Error("provider state failure"));

    const res = await request(app)
      .post("/api/a2p-events/twilio")
      .auth(
        process.env.A2P_EVENT_STREAM_USERNAME,
        process.env.A2P_EVENT_STREAM_PASSWORD,
      )
      .send(fixture());

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
