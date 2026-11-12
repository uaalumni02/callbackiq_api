import { safeConsole } from "../../helpers/logging/safeLogger.js";

import { claimAnalysis, analysisIdentity, analysisUpdate, updateAnalyzedLead } from "../../services/conversationIntelligence.persistence.js";

import { beginValuation, finishValuation } from "../../services/valuation/opportunityValuation.service.js";

import mongoose from "mongoose";

import Db from "../../db/db.js";

import Business from "../../models/business.js";

import Conversation from "../../models/conversation.js";

import ConversationIntelligence from "../../models/conversationIntelligence.js";

import Lead from "../../models/lead.js";

import Message from "../../models/message.js";

import {
  analyzeConversationSchema,
  feedbackSchema,
  actionSchema,
  opportunityQuerySchema,
  listQuerySchema,
} from "../../validator/conversationIntelligence.js";

import * as Response from "../../helpers/response/response.js";

import ConversationIntelligenceService from "../../services/conversationIntelligence.service.js";

import SocketService from "../../services/socket.service.js";

const getMessagesForAnalysis = (conversationId,businessId) => Db.getMessagesForAI(Message,conversationId,businessId);

export { Business, Conversation, ConversationIntelligence, ConversationIntelligenceService, Db, Lead, Response, SocketService, analysisIdentity, analysisUpdate, analyzeConversationSchema, beginValuation, claimAnalysis, finishValuation, getMessagesForAnalysis, mongoose, safeConsole, updateAnalyzedLead, listQuerySchema, opportunityQuerySchema, feedbackSchema, actionSchema };
