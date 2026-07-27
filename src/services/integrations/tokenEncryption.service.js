import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const getKey = () => {
  const secret = String(process.env.INTEGRATION_ENCRYPTION_KEY || "").trim();

  if (secret.length < 32) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be configured with at least 32 characters.",
    );
  }

  return crypto.createHash("sha256").update(secret).digest();
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
    throw new Error("Encrypted integration secret has an invalid format.");
  }

  const [iv, authTag, encrypted] = parts.map((value) =>
    Buffer.from(value, "base64url"),
  );
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
};
