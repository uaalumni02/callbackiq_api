import express from "express";
import SupportController from "../controllers/support.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.post("/tickets", checkAuth, SupportController.createTicket);
router.get("/tickets", checkAuth, SupportController.getMyTickets);
router.get("/tickets/:id", checkAuth, SupportController.getMyTicketById);
router.patch("/tickets/:id", checkAuth, SupportController.updateMyTicket);
router.patch("/tickets/:id/close", checkAuth, SupportController.closeMyTicket);

export default router;