export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
export function validAdminSession(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  return claims?.mfaVerified === true && Number.isInteger(claims.authTime) && claims.authTime > 0 &&
    claims.authTime <= nowSeconds && nowSeconds - claims.authTime <= ADMIN_SESSION_SECONDS;
}
