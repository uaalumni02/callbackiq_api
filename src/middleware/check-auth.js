import Token from "../helpers/jwt/token.js";

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
};

const checkAuth = (req, res, next) => {
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

    req.user = decoded;

    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

export default checkAuth;
