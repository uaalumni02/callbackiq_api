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

test('liveness reports the validated deployment commit', async () => {
  const previous = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = '0123456789abcdef0123456789abcdef01234567';
  try {
    const response = await request(app).get('/api/health/live');
    expect(response.body.commit).toBe(process.env.RENDER_GIT_COMMIT);
    process.env.RENDER_GIT_COMMIT = 'not-a-commit';
    expect((await request(app).get('/api/health/live')).body.commit).toBeNull();
  } finally { if (previous === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = previous; }
});
