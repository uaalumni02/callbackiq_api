import request from "supertest";
import app from "../../src/app.js";

test("browser preflight permits Idempotency-Key for appointment writes", async () => {
  const response = await request(app)
    .options("/api/appointments")
    .set("Origin", "http://localhost:3001")
    .set("Access-Control-Request-Method", "POST")
    .set(
      "Access-Control-Request-Headers",
      "content-type,idempotency-key",
    );

  expect([200, 204]).toContain(response.status);
  expect(
    String(response.headers["access-control-allow-headers"] || "").toLowerCase(),
  ).toContain("idempotency-key");
});
