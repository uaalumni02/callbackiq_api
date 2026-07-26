import request from "supertest";
import app from "../../src/app.js";

describe("Phase 1 health endpoints", () => {
  test("liveness returns a request id", async () => {
    const response = await request(app).get("/api/health/live");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("live");
    expect(response.headers["x-request-id"]).toBeTruthy();
  });
});
