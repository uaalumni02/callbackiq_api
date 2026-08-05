const normalizeAddress = (value) =>
  String(value || "unknown")
    .trim()
    .replace(/^::ffff:/, "")
    .slice(0, 100);

const trustedProxySet = () =>
  new Set(
    String(process.env.VOICE_TRUSTED_PROXY_IPS || "")
      .split(",")
      .map(normalizeAddress)
      .filter(Boolean),
  );

export const resolveTrustedClientAddress = (request) => {
  const socketAddress = normalizeAddress(request?.socket?.remoteAddress);
  const trustHeaders = process.env.VOICE_TRUST_PROXY_HEADERS === "true";
  if (!trustHeaders || !trustedProxySet().has(socketAddress)) return socketAddress;
  const forwarded = String(request?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map(normalizeAddress)
    .find(Boolean);
  return forwarded || socketAddress;
};

export const resolveTrustedRemoteAddress = resolveTrustedClientAddress;

export default { resolveTrustedClientAddress, resolveTrustedRemoteAddress };
