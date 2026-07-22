import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import SupportTicket from "../models/supportTicket.js";

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

const createTicket = async (req, res) => {
  try {
    const business = await getUserBusiness(req);
    const userId = getUserId(req);

    const {
      subject,
      category = "other",
      priority = "medium",
      message,
    } = req.body;

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Subject and message are required.",
      });
    }

    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: "Invalid support category.",
      });
    }

    if (!validPriorities.includes(priority)) {
      return res.status(400).json({
        success: false,
        message: "Invalid support priority.",
      });
    }

    const ticket = await Db.saveSupportTicket(SupportTicket, {
      business: business._id,
      user: userId,
      subject: subject.trim(),
      category,
      priority,
      message: message.trim(),
    });

    return res.status(201).json({
      success: true,
      message: "Support ticket created successfully.",
      data: ticket,
    });
  } catch (error) {
    return res.status(error.message === "Unauthorized." ? 401 : 500).json({
      success: false,
      message: error.message || "Failed to create support ticket.",
    });
  }
};

const getMyTickets = async (req, res) => {
  try {
    const business = await getUserBusiness(req);

    const tickets = await Db.getSupportTicketsByBusiness(
      SupportTicket,
      business._id,
    );

    return res.status(200).json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    return res.status(error.message === "Unauthorized." ? 401 : 500).json({
      success: false,
      message: error.message || "Failed to fetch support tickets.",
    });
  }
};

const getMyTicketById = async (req, res) => {
  try {
    const business = await getUserBusiness(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket id.",
      });
    }

    const ticket = await Db.getSupportTicketForBusiness(
      SupportTicket,
      id,
      business._id,
    );

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    return res.status(error.message === "Unauthorized." ? 401 : 500).json({
      success: false,
      message: error.message || "Failed to fetch support ticket.",
    });
  }
};

const updateMyTicket = async (req, res) => {
  try {
    const business = await getUserBusiness(req);
    const { id } = req.params;
    const { subject, category, priority, message } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket id.",
      });
    }

    const existingTicket = await Db.getSupportTicketForBusiness(
      SupportTicket,
      id,
      business._id,
    );

    if (!existingTicket) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found.",
      });
    }

    if (["resolved", "closed"].includes(existingTicket.status)) {
      return res.status(400).json({
        success: false,
        message: "Closed or resolved tickets cannot be edited.",
      });
    }

    const update = {};

    if (typeof subject === "string") {
      if (!subject.trim()) {
        return res.status(400).json({
          success: false,
          message: "Subject cannot be empty.",
        });
      }

      update.subject = subject.trim();
    }

    if (typeof message === "string") {
      if (!message.trim()) {
        return res.status(400).json({
          success: false,
          message: "Message cannot be empty.",
        });
      }

      update.message = message.trim();
    }

    if (category) {
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          success: false,
          message: "Invalid support category.",
        });
      }

      update.category = category;
    }

    if (priority) {
      if (!validPriorities.includes(priority)) {
        return res.status(400).json({
          success: false,
          message: "Invalid support priority.",
        });
      }

      update.priority = priority;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid ticket updates provided.",
      });
    }

    const ticket = await Db.updateSupportTicketForBusiness(
      SupportTicket,
      id,
      business._id,
      update,
    );

    return res.status(200).json({
      success: true,
      message: "Support ticket updated successfully.",
      data: ticket,
    });
  } catch (error) {
    return res.status(error.message === "Unauthorized." ? 401 : 500).json({
      success: false,
      message: error.message || "Failed to update support ticket.",
    });
  }
};

const closeMyTicket = async (req, res) => {
  try {
    const business = await getUserBusiness(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket id.",
      });
    }

    const ticket = await Db.closeSupportTicketForBusiness(
      SupportTicket,
      id,
      business._id,
    );

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Support ticket closed.",
      data: ticket,
    });
  } catch (error) {
    return res.status(error.message === "Unauthorized." ? 401 : 500).json({
      success: false,
      message: error.message || "Failed to close support ticket.",
    });
  }
};

const getAllTicketsAdmin = async (req, res) => {
  try {
    const { status, category, priority } = req.query;

    const filter = {};

    if (status && validStatuses.includes(status)) {
      filter.status = status;
    }

    if (category && validCategories.includes(category)) {
      filter.category = category;
    }

    if (priority && validPriorities.includes(priority)) {
      filter.priority = priority;
    }

    const tickets = await Db.getAllSupportTickets(SupportTicket, filter);

    return res.status(200).json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch admin support tickets.",
    });
  }
};

const updateTicketAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority, adminNotes } = req.body;
    const adminId = getUserId(req);

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket id.",
      });
    }

    const update = {};
    const pushUpdate = {};

    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket status.",
        });
      }

      update.status = status;
      update.resolvedAt = ["resolved", "closed"].includes(status)
        ? new Date()
        : null;
    }

    if (priority) {
      if (!validPriorities.includes(priority)) {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket priority.",
        });
      }

      update.priority = priority;
    }

    if (typeof adminNotes === "string") {
      const trimmedNote = adminNotes.trim();

      update.adminNotes = trimmedNote;
      update.lastUpdatedBy = adminId;
      update.lastAdminUpdateAt = new Date();

      if (trimmedNote) {
        pushUpdate.ticketHistory = {
          note: trimmedNote,
          admin: adminId,
          createdAt: new Date(),
        };
      }
    }

    if (
      Object.keys(update).length === 0 &&
      Object.keys(pushUpdate).length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "No valid ticket updates provided.",
      });
    }

    const updateQuery = { $set: update };

    if (Object.keys(pushUpdate).length > 0) {
      updateQuery.$push = pushUpdate;
    }

    const ticket = await Db.updateSupportTicketAdmin(
      SupportTicket,
      id,
      updateQuery,
    );

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Support ticket updated.",
      data: ticket,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update support ticket.",
    });
  }
};

export default {
  createTicket,
  getMyTickets,
  getMyTicketById,
  updateMyTicket,
  closeMyTicket,
  getAllTicketsAdmin,
  updateTicketAdmin,
};
