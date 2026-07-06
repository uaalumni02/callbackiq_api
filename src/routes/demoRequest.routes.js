import express from "express";

import DemoRequestController from "../controllers/demoRequest.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.post("/", DemoRequestController.createDemoRequest);

router.get("/", checkAuth, DemoRequestController.getDemoRequests);
router.get("/:id", checkAuth, DemoRequestController.getDemoRequestById);
router.patch("/:id", checkAuth, DemoRequestController.updateDemoRequest);
router.delete("/:id", checkAuth, DemoRequestController.deleteDemoRequest);

export default router;
