import Token from "../helpers/jwt/token.js";
import User from "../models/user.js";
import Business from "../models/business.js";

const TOKEN_COOKIE_NAME = "token";

/**
 * Parses a Cookie request header without requiring another dependency.
 *
 * Example header:
 * token=abc123; theme=dark
 */
const parseCookies = (cookieHeader = "") => {
  return cookieHeader.split(";").reduce((cookies, cookie) => {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) {
      return cookies;
    }

    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();

    if (!name) {
      return cookies;
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }

    return cookies;
  }, {});
};

/**
 * Extracts the JWT from one of the supported Socket.IO authentication methods.
 *
 * Priority:
 * 1. socket.handshake.auth.token
 * 2. Authorization: Bearer <token>
 * 3. HTTP-only token cookie
 */
const getSocketToken = (socket) => {
  const authToken = socket.handshake.auth?.token;

  if (typeof authToken === "string" && authToken.trim()) {
    return authToken.trim();
  }

  const authorizationHeader = socket.handshake.headers?.authorization;

  if (
    typeof authorizationHeader === "string" &&
    authorizationHeader.startsWith("Bearer ")
  ) {
    return authorizationHeader.slice(7).trim();
  }

  const cookies = parseCookies(socket.handshake.headers?.cookie);
  const cookieToken = cookies[TOKEN_COOKIE_NAME];

  if (typeof cookieToken === "string" && cookieToken.trim()) {
    return cookieToken.trim();
  }

  return null;
};

const createSocketError = (message, code) => {
  const error = new Error(message);

  error.data = {
    code,
  };

  return error;
};

/**
 * Authenticates a Socket.IO connection and determines which rooms the socket
 * may join.
 *
 * The server resolves the business from the authenticated user. The frontend
 * is never trusted to provide a business ID.
 */
const socketAuth = async (socket, next) => {
  try {
    const token = getSocketToken(socket);

    if (!token) {
      return next(
        createSocketError(
          "Authentication is required.",
          "SOCKET_AUTH_REQUIRED",
        ),
      );
    }

    const decoded = Token.verify(token);
    const userId = decoded?.userId;

    if (!userId) {
      return next(
        createSocketError(
          "The authentication token is invalid.",
          "SOCKET_INVALID_TOKEN",
        ),
      );
    }

    const user = await User.findById(userId).select(
      "_id userName email role businessName",
    );

    if (!user) {
      return next(
        createSocketError(
          "The authenticated user no longer exists.",
          "SOCKET_USER_NOT_FOUND",
        ),
      );
    }

    socket.data.user = {
      userId: user._id.toString(),
      userName: user.userName,
      email: user.email,
      role: user.role,
    };

    /*
     * Every authenticated connection receives a private user room.
     * This can later support account-specific notifications.
     */
    socket.join(`user:${user._id}`);

    /*
     * Platform administrators do not currently belong to a single business.
     * They receive an admin room but are not automatically placed into every
     * customer's room.
     */
    if (user.role === "admin") {
      socket.data.businessId = null;
      socket.join("role:admin");

      return next();
    }

    /*
     * The current data model connects businesses directly to their owners.
     * Members will require a BusinessMember relationship before they can be
     * securely resolved to a business.
     */
    if (user.role === "member") {
      return next(
        createSocketError(
          "A business membership is required for real-time access.",
          "SOCKET_BUSINESS_MEMBERSHIP_REQUIRED",
        ),
      );
    }

    const business = await Business.findOne({ owner: user._id }).select(
      "_id businessName isActive owner",
    );

    if (!business) {
      return next(
        createSocketError(
          "No business is associated with this account.",
          "SOCKET_BUSINESS_NOT_FOUND",
        ),
      );
    }

    if (!business.isActive) {
      return next(
        createSocketError(
          "This business account is inactive.",
          "SOCKET_BUSINESS_INACTIVE",
        ),
      );
    }

    socket.data.businessId = business._id.toString();
    socket.data.business = {
      businessId: business._id.toString(),
      businessName: business.businessName,
    };

    socket.join(`business:${business._id}`);
    socket.join(`role:${user.role}`);

    return next();
  } catch (error) {
    if (
      error?.name === "TokenExpiredError" ||
      error?.name === "JsonWebTokenError" ||
      error?.name === "NotBeforeError"
    ) {
      return next(
        createSocketError(
          "The authentication token is invalid or expired.",
          "SOCKET_INVALID_TOKEN",
        ),
      );
    }

    console.error("Socket authentication error:", error);

    return next(
      createSocketError(
        "Unable to authenticate the real-time connection.",
        "SOCKET_AUTH_FAILED",
      ),
    );
  }
};

export { getSocketToken, parseCookies };

export default socketAuth;
