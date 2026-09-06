import Token from "../helpers/jwt/token.js";
import User from "../models/user.js";

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const rejectAuthentication = (res) =>
  res.status(401).json({
    success: false,
    message: "Invalid or expired token",
  });

const checkAuth = async (req, res, next) => {
  try {
    const cookieToken = req.cookies?.token || null;
    const bearerToken = getBearerToken(req.headers.authorization);
    const token = cookieToken || bearerToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const decoded = Token.verify(token);
    const userId = decoded?.userId;
    if (!userId) return rejectAuthentication(res);

    // Per-user sessionVersion makes password reset and future "log out all
    // devices" operations revoke previously issued JWTs without rotating the
    // global JWT secret. Legacy tokens are treated as version 0.
    const user = await User.findById(userId)
      .select("_id role +sessionVersion")
      .lean();

    if (!user) return rejectAuthentication(res);

    const tokenSessionVersion = Number(decoded?.sessionVersion ?? 0);
    const currentSessionVersion = Number(user.sessionVersion ?? 0);
    if (
      !Number.isInteger(tokenSessionVersion) ||
      tokenSessionVersion < 0 ||
      tokenSessionVersion !== currentSessionVersion
    ) {
      return rejectAuthentication(res);
    }

    // Role is refreshed from the database so a stale token cannot retain an
    // elevated role after an administrative role change.
    req.user = {
      ...decoded,
      userId: String(user._id),
      role: user.role,
      sessionVersion: currentSessionVersion,
    };

    return next();
  } catch {
    return rejectAuthentication(res);
  }
};

export { getBearerToken };
export default checkAuth;
