import express from "express";

import checkAuth from "../middleware/check-auth.js";
import BusinessController from "../controllers/business.js";

const router = express.Router();

router.route("/").post(checkAuth, BusinessController.createBusiness);

router
  .route("/mine")
  .get(checkAuth, BusinessController.getMyBusiness)
  .patch(checkAuth, BusinessController.updateMyBusiness)
  .delete(checkAuth, BusinessController.deleteMyBusiness);

router.route("/:id").get(checkAuth, BusinessController.getBusinessById);

export default router;
