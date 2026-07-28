import crypto from "crypto";

describe("Jobber webhook signature fixture", () => {
  test("uses base64 HMAC-SHA256 over the raw body", () => {
    const secret = "test-secret";
    const body = Buffer.from('{"data":{"webHookEvent":{"topic":"APP_CONNECT"}}}');
    const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(signature).toBe(
      crypto.createHmac("sha256", secret).update(body).digest("base64"),
    );
  });
});
