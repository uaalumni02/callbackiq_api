const normalizeAddress = (value) =>
  String(value || "")
    .trim()
    .replace(/^::ffff:/, "")
    .slice(0, 100);

/**
 * Express req.ip is authoritative here because app-level trust-proxy policy
 * decides which proxy hops are trusted. Do not read X-Forwarded-For directly
 * in account/consent/security code.
 */
export const getTrustedRequestIp = (req) =>
  normalizeAddress(req?.ip || req?.socket?.remoteAddress || "");

export default getTrustedRequestIp;
