import { safeConsole } from "../helpers/logging/safeLogger.js";
import Token from "../helpers/jwt/token.js";
import User from "../models/user.js";
import Business from "../models/business.js";

const TOKEN_COOKIE_NAME = "token";

const parseCookies = (cookieHeader = "") => {
  if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
    return {};
  }

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

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
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

  const bearerToken = getBearerToken(socket.handshake.headers?.authorization);

  if (bearerToken) {
    return bearerToken;
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

const joinUserRooms = async (socket, userId, role) => {
  await socket.join(`user:${userId}`);
  await socket.join(`role:${role}`);
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

    /*
     * This is a read-only authentication query, so lean() avoids creating a
     * full Mongoose document for every new Socket.IO connection.
     */
    const user = await User.findById(userId)
      .select("_id userName email role businessName +sessionVersion")
      .lean();

    if (!user) {
      return next(
        createSocketError(
          "The authenticated user no longer exists.",
          "SOCKET_USER_NOT_FOUND",
        ),
      );
    }

    const tokenSessionVersion = Number(decoded?.sessionVersion ?? 0);
    const currentSessionVersion = Number(user.sessionVersion ?? 0);

    if (
      !Number.isInteger(tokenSessionVersion) ||
      tokenSessionVersion < 0 ||
      tokenSessionVersion !== currentSessionVersion
    ) {
      return next(
        createSocketError(
          "The authentication session has been revoked.",
          "SOCKET_SESSION_REVOKED",
        ),
      );
    }

    const normalizedRole = String(user.role || "")
      .trim()
      .toLowerCase();
    const normalizedUserId = String(user._id);

    socket.data.sessionVersion = currentSessionVersion;
    socket.data.tokenExpiresAt = Number(decoded.exp) * 1000;

    socket.data.user = {
      userId: normalizedUserId,
      userName: user.userName,
      email: user.email,
      role: normalizedRole,
    };

    /*
     * Platform administrators do not automatically enter every customer room.
     */
    if (normalizedRole === "admin") {
      socket.data.businessId = null;
      socket.data.business = null;

      await joinUserRooms(socket, normalizedUserId, normalizedRole);

      return next();
    }

    /*
     * Members require an explicit BusinessMember relationship before secure
     * business-room access can be granted.
     */
    if (normalizedRole === "member") {
      return next(
        createSocketError(
          "A business membership is required for real-time access.",
          "SOCKET_BUSINESS_MEMBERSHIP_REQUIRED",
        ),
      );
    }

    const business = await Business.findOne({
      owner: user._id,
    })
      .select("_id businessName isActive owner")
      .lean();

    if (!business) {
      return next(
        createSocketError(
          "No business is associated with this account.",
          "SOCKET_BUSINESS_NOT_FOUND",
        ),
      );
    }

    if (business.isActive !== true) {
      return next(
        createSocketError(
          "This business account is inactive.",
          "SOCKET_BUSINESS_INACTIVE",
        ),
      );
    }

    const businessId = String(business._id);

    socket.data.businessId = businessId;
    socket.data.business = {
      businessId,
      businessName: business.businessName,
    };

    /*
     * Rooms are joined only after all authentication and tenant checks pass.
     */
    await joinUserRooms(socket, normalizedUserId, normalizedRole);
    await socket.join(`business:${businessId}`);

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

    safeConsole.error("Socket authentication error:", error);

    return next(
      createSocketError(
        "Unable to authenticate the real-time connection.",
        "SOCKET_AUTH_FAILED",
      ),
    );
  }
};

export { getBearerToken, getSocketToken, parseCookies };

export default socketAuth;
