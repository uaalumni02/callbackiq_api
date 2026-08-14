import express from "express";
import { receiveA2pComplianceEvents } from "../controllers/a2pEvents.controller.js";

const router = express.Router();
router.post("/twilio", receiveA2pComplianceEvents);
export default router;
