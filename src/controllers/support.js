import mongoose from "mongoose";
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

  const business = await Business.findOne({ owner: userId });

  if (!business) {
    throw new Error("Business not found for this user.");
  }

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

    const ticket = await SupportTicket.create({
      business: business._id,
      user: userId,
      subject,
      category,
      priority,
      message,
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

    const tickets = await SupportTicket.find({ business: business._id })
      .sort({ createdAt: -1 })
      .lean();

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

    const ticket = await SupportTicket.findOne({
      _id: id,
      business: business._id,
    }).lean();

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

    const ticket = await SupportTicket.findOneAndUpdate(
      {
        _id: id,
        business: business._id,
      },
      {
        status: "closed",
        resolvedAt: new Date(),
      },
      { new: true },
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

    if (status && validStatuses.includes(status)) filter.status = status;
    if (category && validCategories.includes(category))
      filter.category = category;
    if (priority && validPriorities.includes(priority))
      filter.priority = priority;

    const tickets = await SupportTicket.find(filter)
      .populate("business", "businessName phone email businessType")
      .populate("user", "userName email role")
      .sort({ createdAt: -1 })
      .lean();

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

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket id.",
      });
    }

    const update = {};

    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket status.",
        });
      }

      update.status = status;

      if (["resolved", "closed"].includes(status)) {
        update.resolvedAt = new Date();
      }
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
      update.adminNotes = adminNotes;
    }

    const ticket = await SupportTicket.findByIdAndUpdate(id, update, {
      new: true,
    })
      .populate("business", "businessName phone email businessType")
      .populate("user", "userName email role");

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
  closeMyTicket,
  getAllTicketsAdmin,
  updateTicketAdmin,
};
