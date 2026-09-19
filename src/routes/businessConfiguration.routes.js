import express from "express";

import BusinessConfigurationController from "../controllers/businessConfiguration.js";
import checkAuth from "../middleware/check-auth.js";

import { getOwnerSettings, putOwnerSettings } from "../controllers/ownerSettings.js";

const router = express.Router();

router.use(checkAuth);
router.get("/owner-settings", getOwnerSettings);
router.put("/owner-settings/:section", putOwnerSettings);

router.get("/bootstrap", BusinessConfigurationController.bootstrap);
router.get("/readiness", BusinessConfigurationController.readiness);
router.post("/evaluate", BusinessConfigurationController.evaluate);

router.get("/services", BusinessConfigurationController.listServices);
router.post("/services", BusinessConfigurationController.createService);
router.patch("/services/:serviceId", BusinessConfigurationController.updateService);
router.delete("/services/:serviceId", BusinessConfigurationController.deleteService);

router.get("/availability", BusinessConfigurationController.getAvailability);
router.put(
  "/availability/rules",
  BusinessConfigurationController.replaceAvailabilityRules,
);
router.post(
  "/availability/exceptions",
  BusinessConfigurationController.createAvailabilityException,
);
router.patch(
  "/availability/exceptions/:exceptionId",
  BusinessConfigurationController.updateAvailabilityException,
);
router.delete(
  "/availability/exceptions/:exceptionId",
  BusinessConfigurationController.deleteAvailabilityException,
);

router.get(
  "/scheduling-policy",
  BusinessConfigurationController.getSchedulingPolicy,
);
router.put(
  "/scheduling-policy",
  BusinessConfigurationController.saveSchedulingPolicy,
);

router.get("/service-area", BusinessConfigurationController.getServiceArea);
router.put("/service-area", BusinessConfigurationController.saveServiceArea);

router.get(
  "/operations-settings",
  BusinessConfigurationController.getOperationsSettings,
);
router.put(
  "/operations-settings",
  BusinessConfigurationController.saveOperationsSettings,
);

export default router;
