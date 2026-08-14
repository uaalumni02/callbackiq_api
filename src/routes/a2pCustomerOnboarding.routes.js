import express from "express";
import checkAuth from "../middleware/check-auth.js";
import {
  getA2pRegistration,
  retryA2pOtp,
  submitA2pRegistration,
  syncA2pRegistration,
} from "../controllers/a2pCustomerOnboarding.controller.js";

const router = express.Router();
router.use(checkAuth);
router.get("/mine/a2p-registration", getA2pRegistration);
router.post("/mine/a2p-registration", submitA2pRegistration);
router.post("/mine/a2p-registration/sync", syncA2pRegistration);
router.post("/mine/a2p-registration/retry-otp", retryA2pOtp);
export default router;
