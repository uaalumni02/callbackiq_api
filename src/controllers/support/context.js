import mongoose from "mongoose";

import Db from "../../db/db.js";

import Business from "../../models/business.js";

import SupportTicket from "../../models/supportTicket.js";

const validCategories = [
  "billing",
  "account",
  "technical",
  "twilio_sms",
  "ai",
  "other",
];

const validPriorities = ["low", "medium", "high"];

const validStatuses = ["open", "in_progress", "resolved", "closed"];

const getUserId = (req) => req.user?.userId || req.user?._id || req.user?.id;

const getUserBusiness = async (req) => {
  const userId = getUserId(req);

  if (!userId) {
    throw new Error("Unauthorized.");
  }

  if (req.business) {
    return req.business;
  }

  const business =
    typeof Db.getBusinessScopeByOwner === "function"
      ? await Db.getBusinessScopeByOwner(Business, userId)
      : await Db.getBusinessByOwner(Business, userId);

  if (!business) {
    throw new Error("Business not found for this user.");
  }

  req.business = business;

  return business;
};
export { Db, SupportTicket, getUserBusiness, getUserId, validCategories, validPriorities, mongoose, validStatuses };
