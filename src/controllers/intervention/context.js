import { listBusinessRequests, readRequestWorkflow, updateRequestWorkflow } from '../../services/businessRequestWorkflow.service.js';

import Conversation from '../../models/conversation.js';

import mongoose from "mongoose";

import Alert from "../../models/alert.js";

import getOwnedBusiness from "../../services/businessScope.service.js";

import SocketService from "../../services/socket.service.js";

const INTERVENTION_TYPES = [
  "safety_emergency",
  "human_requested",
  "angry_customer",
  "low_ai_confidence",
  "booking_conflict",
  "integration_failure",
  "message_delivery_failure",
  "unanswered_hot_lead",
  "appointment_canceled",
  "appointment_change_review",
];

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const populate = (query) =>
  query
    .populate(
      "lead",
      "customerName phone serviceNeeded urgency estimatedValue valuation status summary",
    )
    .populate(
      "conversation",
      "customerName customerPhone lastMessage status humanTakeover",
    )
    .populate("appointment", "startAt endAt timezone status provider")
    .populate("assignedTo", "userName email");

const sendNotFound = (res) =>
  res.status(404).json({
    success: false,
    message: "Intervention not found.",
  });

const sendStateConflict = (res) =>
  res.status(409).json({
    success: false,
    message: "The intervention changed before this action completed. Refresh and try again.",
  });

const getScopedIntervention = ({ interventionId, businessId }) =>
  Alert.findOne({
    _id: interventionId,
    business: businessId,
  });

const getDefaultAssignee = ({ requestedAssignee, business, user }) =>
  requestedAssignee || business?.owner || user?.userId || null;

const normalizeId = (value) => {
  if (value == null) return null;

  const candidate = value?._id ?? value;
  const normalized = String(candidate).trim();
  return normalized || null;
};

const resolveAssignableUserId = ({ business, requestedAssignee }) => {
  const requestedAssigneeId = normalizeId(requestedAssignee);

  // An explicit null means the intervention should be unassigned.
  if (!requestedAssigneeId) return null;

  const ownerId = normalizeId(business?.owner);
  if (!ownerId || requestedAssigneeId !== ownerId) {
    const error = new Error(
      "Only the business owner can be assigned to an intervention.",
    );
    error.statusCode = 403;
    throw error;
  }

  return ownerId;
};

const pauseOwnedReview = async (req, business, alert) => {
  if (req.body.pauseAutomation !== true || !alert.conversation) return;
  let conversation;
  try {
    conversation = await Conversation.findOneAndUpdate({
      _id: normalizeId(alert.conversation), business: business._id,
    }, { $set: { humanTakeover: true, aiEnabled: false } }, { returnDocument: 'after' });
  } catch (cause) {
    throw Object.assign(new Error('Review accepted, but AI pause could not be verified. Refresh and retry takeover.'), { statusCode: 503, cause });
  }
  if (!conversation) throw Object.assign(new Error('Review accepted, but the conversation could not be paused. Retry takeover.'), { statusCode: 409 });
  SocketService.emitConversationUpdated(business._id, conversation);
};

export { Alert, INTERVENTION_TYPES, escapeRegex, getOwnedBusiness, listBusinessRequests, mongoose, populate, readRequestWorkflow, updateRequestWorkflow, SocketService, getScopedIntervention, pauseOwnedReview, resolveAssignableUserId, sendNotFound, sendStateConflict, getDefaultAssignee };

const compareInterventions = (first, second) => {
  const severityDifference =
    (SEVERITY_RANK[second.priority] || 0) -
    (SEVERITY_RANK[first.priority] || 0);

  if (severityDifference !== 0) return severityDifference;

  const firstDue = first.dueAt
    ? new Date(first.dueAt).getTime()
    : Number.MAX_SAFE_INTEGER;
  const secondDue = second.dueAt
    ? new Date(second.dueAt).getTime()
    : Number.MAX_SAFE_INTEGER;

  if (firstDue !== secondDue) return firstDue - secondDue;

  return (
    new Date(second.createdAt || 0).getTime() -
    new Date(first.createdAt || 0).getTime()
  );
};

const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export { SEVERITY_RANK, compareInterventions };
