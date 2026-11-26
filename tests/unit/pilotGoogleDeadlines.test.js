import { googleHttpRequest } from "../../src/services/integrations/googleHttpRequest.js";
test("H10 fetch and response-body stalls have application deadlines", async () => {
  process.env.PILOT_GOOGLE_REQUEST_TIMEOUT_MS = "100";
  try {
    await expect(
      googleHttpRequest(
        "https://google.example.test",
        {},
        () => new Promise(() => {}),
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_PROVIDER_TIMEOUT" });
    const response = await googleHttpRequest(
      "https://google.example.test",
      {},
      async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      }),
    );
    await expect(response.json()).rejects.toMatchObject({
      code: "GOOGLE_PROVIDER_TIMEOUT",
    });
  } finally {
    delete process.env.PILOT_GOOGLE_REQUEST_TIMEOUT_MS;
  }
});
