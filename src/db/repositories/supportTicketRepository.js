import { safeConsole } from "../../helpers/logging/safeLogger.js";

  // ----- Support Ticket methods -----

export async function saveSupportTicket(model, data) {
    try {
      const ticket = new model(data);
      return await ticket.save();
    } catch (error) {
      safeConsole.error("Error saving support ticket:", error);
      throw error;
    }
  }

export async function getSupportTicketsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching support tickets:", error);
      throw error;
    }
  }

export async function getSupportTicketForBusiness(model, ticketId, businessId) {
    try {
      return await model.findOne({ _id: ticketId, business: businessId });
    } catch (error) {
      safeConsole.error("Error fetching support ticket:", error);
      throw error;
    }
  }

export async function updateSupportTicketForBusiness(
    model,
    ticketId,
    businessId,
    data,
  ) {
    try {
      return await model.findOneAndUpdate(
        { _id: ticketId, business: businessId },
        data,
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
    } catch (error) {
      safeConsole.error("Error updating support ticket:", error);
      throw error;
    }
  }

export async function closeSupportTicketForBusiness(model, ticketId, businessId) {
    try {
      return await model.findOneAndUpdate(
        { _id: ticketId, business: businessId },
        {
          status: "closed",
          resolvedAt: new Date(),
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
    } catch (error) {
      safeConsole.error("Error closing support ticket:", error);
      throw error;
    }
  }

export async function getAllSupportTickets(model, filter = {}) {
    try {
      return await model
        .find(filter)
        .populate("business", "businessName phone email businessType")
        .populate("user", "userName email role")
        .populate("lastUpdatedBy", "userName email role")
        .populate("ticketHistory.admin", "userName email role")
        .sort({ createdAt: -1 })
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching admin support tickets:", error);
      throw error;
    }
  }

export async function updateSupportTicketAdmin(model, ticketId, updateQuery) {
    try {
      return await model
        .findByIdAndUpdate(ticketId, updateQuery, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("business", "businessName phone email businessType")
        .populate("user", "userName email role")
        .populate("lastUpdatedBy", "userName email role")
        .populate("ticketHistory.admin", "userName email role");
    } catch (error) {
      safeConsole.error("Error updating support ticket as admin:", error);
      throw error;
    }
  }

