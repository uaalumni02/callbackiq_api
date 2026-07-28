import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const invalidPayloadError = () =>
  new Error("Encrypted integration secret has an invalid format.");

const getKey = () => {
  const secret = String(process.env.INTEGRATION_ENCRYPTION_KEY || "").trim();

  if (secret.length < 32) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be configured with at least 32 characters.",
    );
  }

  return crypto.createHash("sha256").update(secret).digest();
};

const decodeCanonicalBase64Url = (
  value,
  { exactLength, minimumLength = 1 } = {},
) => {
  const normalized = String(value || "");

  if (!normalized || !BASE64URL_PATTERN.test(normalized)) {
    throw invalidPayloadError();
  }

  const decoded = Buffer.from(normalized, "base64url");

  if (
    decoded.length < minimumLength ||
    (exactLength !== undefined && decoded.length !== exactLength) ||
    decoded.toString("base64url") !== normalized
  ) {
    throw invalidPayloadError();
  }

  return decoded;
};

export const encryptSecret = (plainText) => {
  if (!plainText) {
    return "";
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted]
    .map((value) => value.toString("base64url"))
    .join(".");
};

export const decryptSecret = (payload) => {
  if (!payload) {
    return "";
  }

  const parts = String(payload).split(".");
  if (parts.length !== 3) {
    throw invalidPayloadError();
  }

  const iv = decodeCanonicalBase64Url(parts[0], {
    exactLength: IV_LENGTH,
  });
  const authTag = decodeCanonicalBase64Url(parts[1], {
    exactLength: AUTH_TAG_LENGTH,
  });
  const encrypted = decodeCanonicalBase64Url(parts[2]);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
};
