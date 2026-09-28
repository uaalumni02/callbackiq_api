import { randomUUID } from 'node:crypto';
import ConversationIntelligence from '../models/conversationIntelligence.js';
import Lead from '../models/lead.js';

// Longer than the bounded provider timeout + retry. A crashed request is reclaimable.
export const ANALYSIS_LEASE_MS = 5 * 60 * 1000;
export async function claimAnalysis({ businessId, conversationId, leadId, now = new Date() }) {
  const analysisRequestId = randomUUID();
  try {
    return await ConversationIntelligence.findOneAndUpdate({
      business: businessId,
      conversation: conversationId,
      $or: [
        { status: { $ne: 'processing' } },
        { analysisLeaseExpiresAt: { $lte: now } },
        { analysisLeaseExpiresAt: null, updatedAt: { $lte: new Date(now.getTime() - ANALYSIS_LEASE_MS) } },
      ],
    }, { $set: {
      business: businessId, conversation: conversationId, lead: leadId || null,
      analysisRequestId, status: 'processing', errorMessage: '',
      analysisLeaseExpiresAt: new Date(now.getTime() + ANALYSIS_LEASE_MS),
    } }, { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true });
  } catch (error) {
    // The existing unique conversation index makes simultaneous first claims safe.
    if (error?.code === 11000) return null;
    throw error;
  }
}

export function analysisIdentity(claim, now = new Date()) {
  return { business: claim.business, conversation: claim.conversation,
    analysisRequestId: claim.analysisRequestId, status: 'processing',
    analysisLeaseExpiresAt: { $gt: now } };
}

export function analysisUpdate(analysis) {
  // Only analysis-owned fields can be replaced. Staff fields are deliberately absent.
  const allowed = ['summary', 'customerIntent', 'sentiment', 'buyingLikelihood',
    'appointmentProbability', 'urgency', 'estimatedRevenue', 'objections',
    'missingInformation', 'riskFlags', 'overallConfidence', 'analysisVersion', 'modelUsed'];
  const update = Object.fromEntries(allowed.filter(key => analysis[key] !== undefined).map(key => [key, analysis[key]]));
  for (const key of ['action', 'actionType', 'priority', 'recommendedWithinMinutes', 'suggestedMessage', 'suggestedMessageGuardrail']) {
    if (analysis.nextBestAction?.[key] !== undefined) update[`nextBestAction.${key}`] = analysis.nextBestAction[key];
  }
  return update;
}

export async function updateAnalyzedLead({ lead, businessId, analysis }) {
  // Compare-and-set protects edits and new safety information arriving during AI work.
  if (!lead?._id || !lead.updatedAt) return null;
  const rank = { low: 0, medium: 1, high: 2, emergency: 3 };
  const proposed = analysis.urgency?.level === 'normal' ? 'medium' : analysis.urgency?.level;
  const changes = { summary: analysis.summary, leadQualityScore: analysis.buyingLikelihood.score };
  // Analysis may raise urgency, but only staff/intake resolution may lower it.
  if (rank[proposed] !== undefined && rank[proposed] > (rank[lead.urgency] ?? -1)) changes.urgency = proposed;
  return Lead.findOneAndUpdate({ _id: lead._id, business: businessId, updatedAt: lead.updatedAt },
    { $set: changes }, { returnDocument: 'after', runValidators: true });
}
