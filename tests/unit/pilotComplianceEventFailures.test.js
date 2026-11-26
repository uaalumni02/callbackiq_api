import { receiveA2pComplianceEvents } from "../../src/controllers/a2pEvents.controller.js";
import { markComplianceEvent } from "../../src/services/a2pCustomerOnboarding.service.js";
jest.mock("../../src/services/a2pCustomerOnboarding.service.js", () => ({
  markComplianceEvent: jest.fn(),
}));
const original = { ...process.env };
const run = async (body, header) => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
  };
  await receiveA2pComplianceEvents(
    {
      body,
      headers: {
        authorization:
          header ??
          `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`,
      },
    },
    res,
  );
  return res;
};
beforeEach(() => {
  jest.clearAllMocks();
  process.env.A2P_EVENT_STREAM_USERNAME = "synthetic-user";
  process.env.A2P_EVENT_STREAM_PASSWORD = "synthetic-password";
  markComplianceEvent.mockResolvedValue(null);
});
afterEach(() => {
  process.env = { ...original };
});
test.each(["A2P_EVENT_STREAM_USERNAME", "A2P_EVENT_STREAM_PASSWORD"])(
  "H06 missing %s never permits compliance state changes",
  async (name) => {
    delete process.env[name];
    const res = await run({});
    expect(res.status).toHaveBeenCalledWith(401);
    expect(markComplianceEvent).not.toHaveBeenCalled();
  },
);
test("H06 malformed Basic credential cannot authorize a compliance webhook", async () => {
  const res = await run(
    {},
    `Basic ${Buffer.from("no separator").toString("base64")}`,
  );
  expect(res.status).toHaveBeenCalledWith(401);
  expect(markComplianceEvent).not.toHaveBeenCalled();
});
test.each([
  [
    { data: { id: "receipt", timestamp: "2026-01-01" } },
    "receipt",
    "2026-01-01",
  ],
  [
    { data: { event_id: "receipt", updateddate: "2026-01-02" } },
    "receipt",
    "2026-01-02",
  ],
  [{ data: { updatedDate: "2026-01-03" } }, "", "2026-01-03"],
  [
    { payload: { id: "receipt", timestamp: "2026-01-04" } },
    "receipt",
    "2026-01-04",
  ],
  [
    { payload: { event_id: "receipt", updateddate: "2026-01-05" } },
    "receipt",
    "2026-01-05",
  ],
  [{ payload: { updatedDate: "2026-01-06" } }, "", "2026-01-06"],
])(
  "H06 supported provider event envelopes preserve idempotency and ordering evidence: %p",
  async (fields, eventId, eventAt) => {
    const res = await run({
      eventType: "com.twilio.messaging.compliance.synthetic",
      ...fields,
    });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(markComplianceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId, eventAt }),
    );
  },
);
test("H06 unrelated or empty events do not mutate compliance; write errors return retryable status", async () => {
  const res = await run([null, {}, { eventType: "unrelated" }]);
  expect(res.status).toHaveBeenCalledWith(204);
  expect(markComplianceEvent).not.toHaveBeenCalled();
  markComplianceEvent.mockRejectedValue(new Error("synthetic database outage"));
  const failed = await run({
    type: "com.twilio.messaging.compliance.synthetic",
  });
  expect(failed.status).toHaveBeenCalledWith(500);
});
