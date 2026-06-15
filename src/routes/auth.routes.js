import express from "express";
import AuthController from "../controllers/auth.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.post("/register", AuthController.register);

router.post("/login", AuthController.login);

router.get("/me", checkAuth, AuthController.me);

router.post("/logout", AuthController.logout);

export default router;
