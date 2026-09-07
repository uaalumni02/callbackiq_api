import { isIP } from "node:net";
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
  const hops = String(request?.headers?.["x-forwarded-for"] || "").split(",").map(value => normalizeAddress(value));
  if (hops.length > 20 || hops.some(hop => !isIP(hop))) return socketAddress;
  const trusted = trustedProxySet();
  let address = socketAddress;
  for (let i = hops.length - 1; i >= 0 && trusted.has(address); i--) address = hops[i];
  return address;

};

export const resolveTrustedRemoteAddress = resolveTrustedClientAddress;

export default { resolveTrustedClientAddress, resolveTrustedRemoteAddress };
