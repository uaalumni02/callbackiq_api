export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
export function validAdminSession(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  return claims?.mfaVerified === true && Number.isInteger(claims.authTime) && claims.authTime > 0 &&
    claims.authTime <= nowSeconds && nowSeconds - claims.authTime <= ADMIN_SESSION_SECONDS;
}

export function assertAdminSession(claims, method, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (claims?.mfaVerified !== true) throw Object.assign(new Error('Sign in with administrator verification.'), {
    statusCode: 401, code: 'ADMIN_MFA_REQUIRED',
  });
  const limit = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? ADMIN_SESSION_SECONDS : 900;
  const age = nowSeconds - claims.authTime;
  if (!Number.isInteger(claims.authTime) || !Number.isFinite(age) || age < 0 || age > limit) {
    throw Object.assign(new Error('Sign in again before continuing this administrator action.'), {
      statusCode: 401, code: 'ADMIN_REAUTH_REQUIRED',
    });
  }
}
