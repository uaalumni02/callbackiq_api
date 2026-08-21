import ProductionOperationLease from "../../src/models/productionOperationLease.js";
import RequestRateLimitBucket from "../../src/models/requestRateLimitBucket.js";

describe("production hardening operational models", () => {
  test("distributed lease has an expiresAt TTL index", () => {
    const indexes = ProductionOperationLease.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { expiresAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: "expires_at_ttl",
          }),
        ],
      ]),
    );
  });

  test("request rate-limit bucket has an expiresAt TTL index", () => {
    const indexes = RequestRateLimitBucket.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { expiresAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: "expires_at_ttl",
          }),
        ],
      ]),
    );
  });
});
