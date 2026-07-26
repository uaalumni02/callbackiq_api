import express from "express";

import checkAuth from "../middleware/check-auth.js";
import BusinessFactsController from "../controllers/businessFacts.js";

const router = express.Router();

router.get("/mine/facts", checkAuth, BusinessFactsController.getMine);
router.put("/mine/facts", checkAuth, BusinessFactsController.updateMine);

export default router;
