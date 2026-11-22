import express from "express";
import SupportController from "../controllers/support.js";
import checkAuth from "../middleware/check-auth.js";
import { rateLimit } from "express-rate-limit";
import { createSetupTicket } from "../controllers/support/Setup.js";

const router = express.Router();

router.post("/setup-tickets", checkAuth, rateLimit({
  windowMs: 60 * 60 * 1000, limit: 20,
  keyGenerator: req => String(req.user.userId),
  standardHeaders: "draft-8", legacyHeaders: false,
  message: { success: false, message: "Too many support attempts. Please try again later or email support." },
}), createSetupTicket);

router.post("/tickets", checkAuth, SupportController.createTicket);
router.get("/tickets", checkAuth, SupportController.getMyTickets);
router.get("/tickets/:id", checkAuth, SupportController.getMyTicketById);
router.patch("/tickets/:id", checkAuth, SupportController.updateMyTicket);
router.patch("/tickets/:id/close", checkAuth, SupportController.closeMyTicket);

export default router;
