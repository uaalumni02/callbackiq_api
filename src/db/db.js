import { createDbidentity1Methods } from './repositories/extracted/identity-1.js';
import { createDboperations1Methods } from './repositories/extracted/operations-1.js';
import { createDbbusiness1Methods } from './repositories/extracted/business-1.js';
import { createDbleads1Methods } from './repositories/extracted/leads-1.js';
import { createDbconversations1Methods } from './repositories/extracted/conversations-1.js';
import { createDbmessages1Methods } from './repositories/extracted/messages-1.js';
import { createDbcalls1Methods } from './repositories/extracted/calls-1.js';
import { createDbreporting1Methods } from './repositories/extracted/reporting-1.js';
import { createDbalerts1Methods } from './repositories/extracted/alerts-1.js';
import { createDbtrial1Methods } from './repositories/extracted/trial-1.js';
import { createDbdemo1Methods } from './repositories/extracted/demo-1.js';
import { createDbintelligence1Methods } from './repositories/extracted/intelligence-1.js';
import * as userIdentityRepository from './repositories/userIdentityRepository.js';
import {BUSINESS_SCOPE_FIELDS,CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS,CONVERSATION_INTELLIGENCE_LEAD_FIELDS} from './repositories/dbProjectionFields.js';
import { safeConsole } from "../helpers/logging/safeLogger.js";
import * as subscriptionRepository from "./repositories/subscriptionRepository.js";
import * as supportTicketRepository from "./repositories/supportTicketRepository.js";
import { verifiedAmountExpression, estimateCoverageGroup } from "../services/valuation/opportunityValue.js";


let __meekcallDbidentity1Cache;
function __meekcallGetDbidentity1Methods() {
  if (!__meekcallDbidentity1Cache) __meekcallDbidentity1Cache = createDbidentity1Methods({ safeConsole });
  return __meekcallDbidentity1Cache;
}

let __meekcallDboperations1Cache;
function __meekcallGetDboperations1Methods() {
  if (!__meekcallDboperations1Cache) __meekcallDboperations1Cache = createDboperations1Methods({ safeConsole });
  return __meekcallDboperations1Cache;
}

let __meekcallDbbusiness1Cache;
function __meekcallGetDbbusiness1Methods() {
  if (!__meekcallDbbusiness1Cache) __meekcallDbbusiness1Cache = createDbbusiness1Methods({ BUSINESS_SCOPE_FIELDS, safeConsole });
  return __meekcallDbbusiness1Cache;
}

let __meekcallDbleads1Cache;
function __meekcallGetDbleads1Methods() {
  if (!__meekcallDbleads1Cache) __meekcallDbleads1Cache = createDbleads1Methods({ safeConsole });
  return __meekcallDbleads1Cache;
}

let __meekcallDbconversations1Cache;
function __meekcallGetDbconversations1Methods() {
  if (!__meekcallDbconversations1Cache) __meekcallDbconversations1Cache = createDbconversations1Methods({ safeConsole });
  return __meekcallDbconversations1Cache;
}

let __meekcallDbmessages1Cache;
function __meekcallGetDbmessages1Methods() {
  if (!__meekcallDbmessages1Cache) __meekcallDbmessages1Cache = createDbmessages1Methods({ safeConsole });
  return __meekcallDbmessages1Cache;
}

let __meekcallDbcalls1Cache;
function __meekcallGetDbcalls1Methods() {
  if (!__meekcallDbcalls1Cache) __meekcallDbcalls1Cache = createDbcalls1Methods({ safeConsole });
  return __meekcallDbcalls1Cache;
}

let __meekcallDbreporting1Cache;
function __meekcallGetDbreporting1Methods() {
  if (!__meekcallDbreporting1Cache) __meekcallDbreporting1Cache = createDbreporting1Methods({ safeConsole, verifiedAmountExpression });
  return __meekcallDbreporting1Cache;
}

let __meekcallDbalerts1Cache;
function __meekcallGetDbalerts1Methods() {
  if (!__meekcallDbalerts1Cache) __meekcallDbalerts1Cache = createDbalerts1Methods({ safeConsole });
  return __meekcallDbalerts1Cache;
}

let __meekcallDbtrial1Cache;
function __meekcallGetDbtrial1Methods() {
  if (!__meekcallDbtrial1Cache) __meekcallDbtrial1Cache = createDbtrial1Methods({ safeConsole });
  return __meekcallDbtrial1Cache;
}

let __meekcallDbdemo1Cache;
function __meekcallGetDbdemo1Methods() {
  if (!__meekcallDbdemo1Cache) __meekcallDbdemo1Cache = createDbdemo1Methods({ safeConsole });
  return __meekcallDbdemo1Cache;
}

let __meekcallDbintelligence1Cache;
function __meekcallGetDbintelligence1Methods() {
  if (!__meekcallDbintelligence1Cache) __meekcallDbintelligence1Cache = createDbintelligence1Methods({ CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS, CONVERSATION_INTELLIGENCE_LEAD_FIELDS });
  return __meekcallDbintelligence1Cache;
}

class Db {
  static async findUserByEmailOrUserName(model, userName, email) {
    return userIdentityRepository.findUserByEmailOrUserName(model, userName, email);
  }

  static async saveUser(model, userData, options = {}) {
    return userIdentityRepository.saveUser(model, userData, options);
  }

  static async getUserById(model, id) {
    return userIdentityRepository.getUserById(model, id);
  }

  // ----- Password Reset methods -----

  static async findUserByEmail(model, email) {
    try {
      return await model.findOne({ email });
    } catch (error) {
      safeConsole.error("Error finding user by email:", error);
      throw error;
    }
  }

  static async savePasswordResetToken(...args) { return __meekcallGetDbidentity1Methods().savePasswordResetToken.apply(this, args); }

  static async findUserByPasswordResetToken(...args) { return __meekcallGetDbidentity1Methods().findUserByPasswordResetToken.apply(this, args); }

  static async saveResetPassword(...args) { return __meekcallGetDbidentity1Methods().saveResetPassword.apply(this, args); }

  static async findUserByLogin(...args) { return __meekcallGetDbidentity1Methods().findUserByLogin.apply(this, args); }

  /*
   * Records one failed login atomically.
   *
   * Rules:
   * - Failures are counted inside a rolling 15-minute window.
   * - The fifth failure starts a temporary delay.
   * - Each subsequent block increases the delay.
   * - The escalation level resets after 24 hours without a failure.
   * - CAPTCHA becomes required after the third temporary block.
   */
  static async recordFailedLogin(...args) { return __meekcallGetDboperations1Methods().recordFailedLogin.apply(this, args); }

  static async clearLoginSecurityState(...args) { return __meekcallGetDboperations1Methods().clearLoginSecurityState.apply(this, args); }

  static async decayLoginSecurityState(...args) { return __meekcallGetDboperations1Methods().decayLoginSecurityState.apply(this, args); }

  // ----- Business methods -----

  static async saveBusiness(model, data, { session = null } = {}) {
    try {
      const business = new model(data);
      return await business.save(session ? { session } : undefined);
    } catch (error) {
      safeConsole.error("Error saving business:", error);
      throw error;
    }
  }

  static async getBusinessByOwner(model, ownerId) {
    try {
      return await model
        .findOne({ owner: ownerId })
        .populate("owner", "userName email role");
    } catch (error) {
      safeConsole.error("Error fetching business by owner:", error);
      throw error;
    }
  }

  /*
   * Lightweight tenant lookup for authenticated request handlers.
   * Avoids hydrating a Mongoose document and populating the owner when the
   * controller only needs the business scope and core settings.
   */
  static async getBusinessScopeByOwner(...args) { return __meekcallGetDbbusiness1Methods().getBusinessScopeByOwner.apply(this, args); }
  static async getBusinessById(model, id) {
    try {
      return await model.findById(id).populate("owner", "userName email role");
    } catch (error) {
      safeConsole.error("Error fetching business by ID:", error);
      throw error;
    }
  }

  static async getAllBusinesses(model) {
    try {
      return await model
        .find({})
        .sort({ createdAt: -1 })
        .populate("owner", "userName email role");
    } catch (error) {
      safeConsole.error("Error fetching businesses:", error);
      throw error;
    }
  }

  static async updateBusiness(...args) { return __meekcallGetDbbusiness1Methods().updateBusiness.apply(this, args); }

  static async updateBusinessByOwner(...args) { return __meekcallGetDbbusiness1Methods().updateBusinessByOwner.apply(this, args); }

  static async deleteBusinessByOwner(...args) { return __meekcallGetDbbusiness1Methods().deleteBusinessByOwner.apply(this, args); }

  static async deleteBusiness(...args) { return __meekcallGetDbbusiness1Methods().deleteBusiness.apply(this, args); }
  // ----- Lead methods -----

  static async saveLead(model, data) {
    try {
      const lead = new model(data);
      return await lead.save();
    } catch (error) {
      safeConsole.error("Error saving lead:", error);
      throw error;
    }
  }

  static async getLeadsByBusiness(...args) { return __meekcallGetDbleads1Methods().getLeadsByBusiness.apply(this, args); }
  static async getLeadById(...args) { return __meekcallGetDbleads1Methods().getLeadById.apply(this, args); }
  static async updateLead(...args) { return __meekcallGetDbleads1Methods().updateLead.apply(this, args); }

  static async updateLeadForBusiness(...args) { return __meekcallGetDbleads1Methods().updateLeadForBusiness.apply(this, args); }

  static async deleteLead(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      safeConsole.error("Error deleting lead:", error);
      throw error;
    }
  }

  static async deleteLeadForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      safeConsole.error("Error deleting lead for business:", error);
      throw error;
    }
  }
  // ----- Conversation methods -----

  static async saveConversation(model, data) {
    try {
      const conversation = new model(data);
      return await conversation.save();
    } catch (error) {
      safeConsole.error("Error saving conversation:", error);
      throw error;
    }
  }

  static async getConversationsByBusiness(...args) { return __meekcallGetDbconversations1Methods().getConversationsByBusiness.apply(this, args); }
  static async getConversationById(...args) { return __meekcallGetDbconversations1Methods().getConversationById.apply(this, args); }
  static async getConversationForBusiness(...args) { return __meekcallGetDbconversations1Methods().getConversationForBusiness.apply(this, args); }
  static async updateConversation(...args) { return __meekcallGetDbconversations1Methods().updateConversation.apply(this, args); }

  static async deleteConversation(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      safeConsole.error("Error deleting conversation:", error);
      throw error;
    }
  }

  // ----- Message methods -----

  static async saveMessage(model, data) {
    try {
      const message = new model(data);
      return await message.save();
    } catch (error) {
      safeConsole.error("Error saving message:", error);
      throw error;
    }
  }

  static async getMessagesByConversation(...args) { return __meekcallGetDbmessages1Methods().getMessagesByConversation.apply(this, args); }

  /*
   * AI workflows only need message content and chronology. Skipping populate
   * keeps inbound-SMS and conversation-analysis requests lightweight.
   */
  static async getMessagesForAI(...args) { return __meekcallGetDbmessages1Methods().getMessagesForAI.apply(this, args); }
  static async getMessageById(...args) { return __meekcallGetDbmessages1Methods().getMessageById.apply(this, args); }
  static async getMessageForBusiness(...args) { return __meekcallGetDbmessages1Methods().getMessageForBusiness.apply(this, args); }
  static async deleteMessage(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      safeConsole.error("Error deleting message:", error);
      throw error;
    }
  }

  static async deleteMessageForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      safeConsole.error("Error deleting message for business:", error);
      throw error;
    }
  }
  // ----- Call Log methods -----

  static async saveCallLog(model, data) {
    try {
      const callLog = new model(data);
      return await callLog.save();
    } catch (error) {
      safeConsole.error("Error saving call log:", error);
      throw error;
    }
  }

  static async getCallLogsByBusiness(...args) { return __meekcallGetDbcalls1Methods().getCallLogsByBusiness.apply(this, args); }
  static async getCallLogById(...args) { return __meekcallGetDbcalls1Methods().getCallLogById.apply(this, args); }
  static async getCallLogForBusiness(...args) { return __meekcallGetDbcalls1Methods().getCallLogForBusiness.apply(this, args); }
  static async updateCallLog(...args) { return __meekcallGetDbcalls1Methods().updateCallLog.apply(this, args); }

  static async updateCallLogForBusiness(...args) { return __meekcallGetDbcalls1Methods().updateCallLogForBusiness.apply(this, args); }

  static async deleteCallLog(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      safeConsole.error("Error deleting call log:", error);
      throw error;
    }
  }

  static async deleteCallLogForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      safeConsole.error("Error deleting call log for business:", error);
      throw error;
    }
  }
  // ----- Twilio helper methods -----

  static async getBusinessByPhone(...args) { return __meekcallGetDbbusiness1Methods().getBusinessByPhone.apply(this, args); }

  static async getBusinessByPhoneForWebhook(...args) { return __meekcallGetDbbusiness1Methods().getBusinessByPhoneForWebhook.apply(this, args); }
  static async getFirstBusiness(model) {
    try {
      return await model.findOne({}).sort({ createdAt: 1 });
    } catch (error) {
      safeConsole.error("Error fetching first business:", error);
      throw error;
    }
  }

  static async getLeadByBusinessAndPhone(...args) { return __meekcallGetDbleads1Methods().getLeadByBusinessAndPhone.apply(this, args); }
  static async getConversationByBusinessAndPhone(...args) { return __meekcallGetDbconversations1Methods().getConversationByBusinessAndPhone.apply(this, args); }
  static async updateCallLogByProviderCallId(...args) { return __meekcallGetDbcalls1Methods().updateCallLogByProviderCallId.apply(this, args); }
  // ----- Dashboard methods -----

  static async getDashboardMetrics(...args) { return __meekcallGetDbreporting1Methods().getDashboardMetrics.apply(this, args); }
  static async getLeadForBusiness(model, leadId, businessId) {
    try {
      return await model.findOne({
        _id: leadId,
        business: businessId,
      });
    } catch (error) {
      safeConsole.error("Error fetching lead for business:", error);
      throw error;
    }
  }
  static async qualifyLead(...args) { return __meekcallGetDbleads1Methods().qualifyLead.apply(this, args); }
  // ----- Alert methods -----

  static async saveAlert(model, data) {
    try {
      const alert = new model(data);
      return await alert.save();
    } catch (error) {
      safeConsole.error("Error saving alert:", error);
      throw error;
    }
  }

  static async getAlertsByBusiness(...args) { return __meekcallGetDbalerts1Methods().getAlertsByBusiness.apply(this, args); }
  static async getUnreadAlertsByBusiness(...args) { return __meekcallGetDbalerts1Methods().getUnreadAlertsByBusiness.apply(this, args); }
  static async getAlertById(...args) { return __meekcallGetDbalerts1Methods().getAlertById.apply(this, args); }
  static async getAlertForBusiness(...args) { return __meekcallGetDbalerts1Methods().getAlertForBusiness.apply(this, args); }
  static async updateAlert(...args) { return __meekcallGetDbalerts1Methods().updateAlert.apply(this, args); }

  static async updateAlertForBusiness(...args) { return __meekcallGetDbalerts1Methods().updateAlertForBusiness.apply(this, args); }

  static async markAlertAsRead(...args) { return __meekcallGetDbalerts1Methods().markAlertAsRead.apply(this, args); }

  static async markAlertAsReadForBusiness(...args) { return __meekcallGetDbalerts1Methods().markAlertAsReadForBusiness.apply(this, args); }

  static async markAllAlertsAsRead(...args) { return __meekcallGetDbalerts1Methods().markAllAlertsAsRead.apply(this, args); }

  static async deleteAlert(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      safeConsole.error("Error deleting alert:", error);
      throw error;
    }
  }

  static async deleteAlertForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      safeConsole.error("Error deleting alert for business:", error);
      throw error;
    }
  }
  // ----- Subscription / Billing methods -----
  static async getSubscriptionByBusiness(...args) {
    return subscriptionRepository.getSubscriptionByBusiness(...args);
  }

  static async getSubscriptionByStripeCustomer(...args) {
    return subscriptionRepository.getSubscriptionByStripeCustomer(...args);
  }

  static async getSubscriptionByStripeSubscription(...args) {
    return subscriptionRepository.getSubscriptionByStripeSubscription(...args);
  }

  static async upsertSubscriptionByBusiness(...args) {
    return subscriptionRepository.upsertSubscriptionByBusiness(...args);
  }

  static async updateSubscriptionByStripeSubscription(...args) {
    return subscriptionRepository.updateSubscriptionByStripeSubscription(...args);
  }

  // ----- Support Ticket methods -----
  static async saveSupportTicket(...args) {
    return supportTicketRepository.saveSupportTicket(...args);
  }

  static async getSupportTicketsByBusiness(...args) {
    return supportTicketRepository.getSupportTicketsByBusiness(...args);
  }

  static async getSupportTicketForBusiness(...args) {
    return supportTicketRepository.getSupportTicketForBusiness(...args);
  }

  static async updateSupportTicketForBusiness(...args) {
    return supportTicketRepository.updateSupportTicketForBusiness(...args);
  }

  static async closeSupportTicketForBusiness(...args) {
    return supportTicketRepository.closeSupportTicketForBusiness(...args);
  }

  static async getAllSupportTickets(...args) {
    return supportTicketRepository.getAllSupportTickets(...args);
  }

  static async updateSupportTicketAdmin(...args) {
    return supportTicketRepository.updateSupportTicketAdmin(...args);
  }

  // ----- Admin methods -----

  static async adminUpdateBusinessStatus(...args) { return __meekcallGetDbbusiness1Methods().adminUpdateBusinessStatus.apply(this, args); }

  static async createAdminActionLog(AdminActionLog, payload) {
    try {
      const log = new AdminActionLog(payload);
      return await log.save();
    } catch (error) {
      safeConsole.error("Error creating admin action log:", error);
      throw error;
    }
  }

  // ----- Trial Redemption methods -----

  static async findTrialRedemption(...args) { return __meekcallGetDbtrial1Methods().findTrialRedemption.apply(this, args); }

  static async createTrialRedemption(...args) { return __meekcallGetDbtrial1Methods().createTrialRedemption.apply(this, args); }

  static async deleteTrialRedemptionsForBusiness(model, businessId) {
    try {
      return await model.deleteMany({ business: businessId });
    } catch (error) {
      safeConsole.error("Error deleting trial redemptions:", error);
      throw error;
    }
  }

  // ----- Demo Request methods -----

  static async saveDemoRequest(model, data) {
    try {
      const demoRequest = new model(data);
      return await demoRequest.save();
    } catch (error) {
      safeConsole.error("Error saving demo request:", error);
      throw error;
    }
  }

  static async getDemoRequests(model, filter = {}) {
    try {
      return await model.find(filter).sort({ createdAt: -1 }).lean();
    } catch (error) {
      safeConsole.error("Error fetching demo requests:", error);
      throw error;
    }
  }

  static async getDemoRequestById(model, id) {
    try {
      return await model.findById(id).lean();
    } catch (error) {
      safeConsole.error("Error fetching demo request:", error);
      throw error;
    }
  }

  static async updateDemoRequest(...args) { return __meekcallGetDbdemo1Methods().updateDemoRequest.apply(this, args); }

  static async deleteDemoRequest(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      safeConsole.error("Error deleting demo request:", error);
      throw error;
    }
  }
  static async getConversationIntelligenceByConversation(...args) { return __meekcallGetDbintelligence1Methods().getConversationIntelligenceByConversation.apply(this, args); }

  static async getConversationIntelligenceForBusinessByConversation(...args) { return __meekcallGetDbintelligence1Methods().getConversationIntelligenceForBusinessByConversation.apply(this, args); }
  static async getConversationIntelligenceDocument(
    ConversationIntelligence,
    conversationId,
  ) {
    return ConversationIntelligence.findOne({
      conversation: conversationId,
    });
  }

  static async getConversationIntelligenceByBusiness(...args) { return __meekcallGetDbintelligence1Methods().getConversationIntelligenceByBusiness.apply(this, args); }
  static async getConversationIntelligenceOpportunities(...args) { return __meekcallGetDbintelligence1Methods().getConversationIntelligenceOpportunities.apply(this, args); }
  static async saveConversationIntelligence(...args) { return __meekcallGetDbintelligence1Methods().saveConversationIntelligence.apply(this, args); }

  static async updateConversationIntelligence(...args) { return __meekcallGetDbintelligence1Methods().updateConversationIntelligence.apply(this, args); }

  static async updateConversationIntelligenceForBusiness(...args) { return __meekcallGetDbintelligence1Methods().updateConversationIntelligenceForBusiness.apply(this, args); }

  static async deleteConversationIntelligence(
    ConversationIntelligence,
    conversationId,
  ) {
    return ConversationIntelligence.findOneAndDelete({
      conversation: conversationId,
    });
  }

  static async deleteConversationIntelligenceForBusiness(
    ConversationIntelligence,
    conversationId,
    businessId,
  ) {
    return ConversationIntelligence.findOneAndDelete({
      conversation: conversationId,
      business: businessId,
    });
  }

  static async getConversationIntelligenceDashboard(...args) { return __meekcallGetDbintelligence1Methods().getConversationIntelligenceDashboard.apply(this, args); }
}

export default Db;
