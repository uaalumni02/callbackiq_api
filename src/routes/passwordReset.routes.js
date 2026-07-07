import express from "express";
import AuthController from "../controllers/auth.js";

const router = express.Router();

router.post("/", AuthController.requestPasswordReset);
router.post("/:resetToken", AuthController.resetPassword);

export default router;
