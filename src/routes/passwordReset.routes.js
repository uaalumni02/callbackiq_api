import express from "express";
import AuthController from "../controllers/auth.js";

import {
  distributedPasswordResetRequestRateLimit,
  distributedPasswordResetSubmitRateLimit,
} from '../middleware/auth-distributed-rate-limits.js';
import {
  passwordResetRequestRateLimit,
  passwordResetSubmitRateLimit,
} from '../middleware/auth-public-rate-limits.js';

const router = express.Router();

router.post("/", distributedPasswordResetRequestRateLimit, passwordResetRequestRateLimit, AuthController.requestPasswordReset);
router.post("/:resetToken", distributedPasswordResetSubmitRateLimit, passwordResetSubmitRateLimit, AuthController.resetPassword);

export default router;
