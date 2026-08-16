import express from "express";

import AuthController from "../controllers/auth.js";
import checkAuth from "../middleware/check-auth.js";
import loginRateLimit from "../middleware/login-rate-limit.js";
import {
  registerRateLimit,
  passwordResetRequestRateLimit,
  passwordResetSubmitRateLimit,
} from "../middleware/auth-public-rate-limits.js";

const router = express.Router();

router.post("/register", registerRateLimit, AuthController.register);

router.post("/login", loginRateLimit, AuthController.login);

router.get("/me", checkAuth, AuthController.me);

router.post("/logout", AuthController.logout);

router.post(
  "/request-password-reset",
  passwordResetRequestRateLimit,
  AuthController.requestPasswordReset,
);

router.post(
  "/reset-password/:resetToken",
  passwordResetSubmitRateLimit,
  AuthController.resetPassword,
);

export default router;
