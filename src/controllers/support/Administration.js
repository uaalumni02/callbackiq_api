import {updateSupportTicketAsAdmin} from '../../db/repositories/privileged/supportTickets.js';
import Db from "../../db/db.js";
import SupportTicket from "../../models/supportTicket.js";
import { getUserId, validCategories, validPriorities, validStatuses } from "./helpers.js";
import mongoose from "mongoose";

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

    const ticket=await updateSupportTicketAsAdmin({id,update:updateQuery,actorId:getUserId(req)});

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

export { getAllTicketsAdmin, updateTicketAdmin };
