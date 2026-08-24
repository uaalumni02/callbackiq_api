import {
  decryptSecret,
  encryptSecret,
} from "../../src/services/integrations/tokenEncryption.service.js";

describe("integration token encryption", () => {
  const originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = "a-secure-integration-key-that-is-longer-than-32-characters";
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;
  });

  test("round trips a secret without exposing the plaintext", () => {
    const encrypted = encryptSecret("refresh-token-value");
    expect(encrypted).not.toContain("refresh-token-value");
    expect(encrypted.split(".")).toHaveLength(3);
    expect(decryptSecret(encrypted)).toBe("refresh-token-value");
  });

  test("uses a different IV for repeated encryption", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("returns an empty string for empty values", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBe("");
  });

  test("requires a sufficiently long encryption key", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = "too-short";
    expect(() => encryptSecret("secret")).toThrow("at least 32 characters");
  });

  test("rejects malformed and tampered payloads", () => {
    expect(() => decryptSecret("bad-format")).toThrow("invalid format");
    const encrypted = encryptSecret("secret");
    const [iv, tag, body] = encrypted.split(".");

    const tamperedBody =
      `${body[0] === "A" ? "B" : "A"}${body.slice(1)}`;

    expect(() => decryptSecret(`${iv}.${tag}.${tamperedBody}`)).toThrow();
  });
});
