import { refreshUpcomingAppointmentNotifications } from '../../services/scheduling/appointmentNotification.service.js';

import { safeConsole } from "../../helpers/logging/safeLogger.js";

import Business from "../../models/business.js";

import AvailabilityException from "../../models/availabilityException.js";

import AvailabilityRule from "../../models/availabilityRule.js";

import BusinessOperationsSettings from "../../models/businessOperationsSettings.js";

import SchedulingPolicy from "../../models/schedulingPolicy.js";

import ServiceArea from "../../models/serviceArea.js";

import ServiceOffering from "../../models/serviceOffering.js";

import {
  getBusinessConfigurationBootstrap,
  getConfigurationReadiness,
} from "../../services/businessConfiguration.service.js";

import { evaluateBookingEligibility } from "../../services/bookingEligibility.service.js";

import {
  availabilityRulesSchema,
  createAvailabilityExceptionSchema,
  createServiceOfferingSchema,
  evaluateBookingSchema,
  operationsSettingsSchema,
  schedulingPolicySchema,
  serviceAreaSchema,
  updateAvailabilityExceptionSchema,
  updateServiceOfferingSchema,
} from "../../validator/businessConfiguration.js";

const getOwnerBusiness = async (req) => {
  const ownerId = req.user?.userId;
  if (!ownerId) return null;
  return Business.findOne({ owner: ownerId });
};

const respondNotFound = (res, message = "Business not found") =>
  res.status(404).json({ success: false, message });

const respondError = (res, error) => {
  if (error?.isJoi) {
    return res.status(400).json({
      success: false,
      message: error.details?.[0]?.message || error.message,
    });
  }

  if (error?.name === "CastError") {
    return res.status(400).json({ success: false, message: "Invalid identifier" });
  }

  if (error?.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "A configuration record with these values already exists",
    });
  }

  safeConsole.error("Business configuration error:", error);
  return res.status(500).json({
    success: false,
    message: "Unable to process business configuration",
  });
};

export { getBusinessConfigurationBootstrap, getOwnerBusiness, respondError, respondNotFound, ServiceOffering, createServiceOfferingSchema, updateServiceOfferingSchema, AvailabilityException, AvailabilityRule, availabilityRulesSchema, createAvailabilityExceptionSchema, updateAvailabilityExceptionSchema, SchedulingPolicy, refreshUpcomingAppointmentNotifications, schedulingPolicySchema, ServiceArea, serviceAreaSchema, BusinessOperationsSettings, operationsSettingsSchema, getConfigurationReadiness, evaluateBookingEligibility, evaluateBookingSchema };
