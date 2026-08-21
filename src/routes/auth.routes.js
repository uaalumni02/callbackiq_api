import express from "express";

import AuthController from "../controllers/auth.js";
import VerificationController from "../controllers/verification.js";
import checkAuth from "../middleware/check-auth.js";
import loginRateLimit from "../middleware/login-rate-limit.js";
import {
  distributedLoginRateLimit,
  distributedPasswordResetRequestRateLimit,
  distributedPasswordResetSubmitRateLimit,
  distributedRegisterRateLimit,
} from "../middleware/auth-distributed-rate-limits.js";
import {
  registerRateLimit,
  passwordResetRequestRateLimit,
  passwordResetSubmitRateLimit,
} from "../middleware/auth-public-rate-limits.js";
import {
  emailVerificationRequestRateLimit,
  emailVerificationSubmitRateLimit,
} from "../middleware/verification-rate-limits.js";

const router = express.Router();

router.post("/register", distributedRegisterRateLimit, registerRateLimit, AuthController.register);

router.post("/login", distributedLoginRateLimit, loginRateLimit, AuthController.login);

router.get("/me", checkAuth, AuthController.me);

router.get(
  "/verification-status",
  checkAuth,
  VerificationController.status,
);
router.post(
  "/resend-verification",
  checkAuth,
  emailVerificationRequestRateLimit,
  VerificationController.resendEmail,
);
router.post(
  "/verify-email",
  emailVerificationSubmitRateLimit,
  VerificationController.verifyEmail,
);

router.post("/logout", AuthController.logout);

router.post(
  "/request-password-reset", distributedPasswordResetRequestRateLimit,
  passwordResetRequestRateLimit,
  AuthController.requestPasswordReset,
);

router.post(
  "/reset-password/:resetToken", distributedPasswordResetSubmitRateLimit,
  passwordResetSubmitRateLimit,
  AuthController.resetPassword,
);

export default router;
