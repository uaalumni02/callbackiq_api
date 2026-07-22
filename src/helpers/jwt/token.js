import jwt from "jsonwebtoken";

const getJwtSecret = () => {
  const secret = String(process.env.JWT_SECRET || "").trim();

  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  return secret;
};

const getSharedOptions = () => {
  const options = {
    algorithms: ["HS256"],
  };

  const issuer = String(process.env.JWT_ISSUER || "").trim();
  const audience = String(process.env.JWT_AUDIENCE || "").trim();

  if (issuer) {
    options.issuer = issuer;
  }

  if (audience) {
    options.audience = audience;
  }

  return options;
};

class Token {
  static sign(payload) {
    const sharedOptions = getSharedOptions();

    return jwt.sign(payload, getJwtSecret(), {
      algorithm: "HS256",
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      ...(sharedOptions.issuer ? { issuer: sharedOptions.issuer } : {}),
      ...(sharedOptions.audience ? { audience: sharedOptions.audience } : {}),
    });
  }

  static verify(token) {
    return jwt.verify(token, getJwtSecret(), getSharedOptions());
  }
}

export default Token;
