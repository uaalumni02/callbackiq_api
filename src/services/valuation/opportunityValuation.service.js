import { safeConsole } from "../../helpers/logging/safeLogger.js";
import Lead from "../../models/lead.js";
import ServiceOffering from "../../models/serviceOffering.js";
import { resolveOpportunityValue, ownerEstimate, unknownEstimate } from "./opportunityValue.js";
export * from "./opportunityValue.js";
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';

// Reserve BEFORE asynchronous analysis. A later request invalidates earlier work.
async function reserveValuation(lead, businessId) {
  if (!lead?._id) return null;
  if (!lead.valuation?.source && lead.estimatedValue == null) {
    // Compare against the stored absence of provenance so a concurrent owner
    // estimate cannot be converted into an automatic value.
    return Lead.findOneAndUpdate({ _id: lead._id, business: businessId,
      "valuation.source": { $exists: false }, estimatedValue: null,
    }, { $set: { valuation: unknownEstimate().valuation }, $inc: { valuationVersion: 1 } }, { returnDocument: "after" }).lean();
  }
  if (!["unknown", "service_catalog", "historical"].includes(lead.valuation?.source)) return null;
  return Lead.findOneAndUpdate({ _id: lead._id, business: businessId,
    "valuation.source": { $in: ["unknown", "service_catalog", "historical"] },
  }, { $inc: { valuationVersion: 1 } }, { returnDocument: "after" }).lean();
}
async function commitValuation(ticket, { businessId, evidence, proposedService = "" }) {
  if (!ticket) return null;
  const services = await ServiceOffering.find({ business: businessId, active: true }).lean();
  const value = resolveOpportunityValue({ businessId, current: ticket, services, evidence, proposedService });
  assertVoiceTurnActive(); assertDistributedLeaseActive();
  return Lead.findOneAndUpdate({ _id: ticket._id, business: businessId,
    valuationVersion: ticket.valuationVersion,
    "valuation.source": { $in: ["unknown", "service_catalog", "historical"] },
  }, { $set: value, $inc: { valuationVersion: 1 } }, { returnDocument: "after", runValidators: true });
}
export async function updateOwnerLead({ lead, businessId, changes, actorId }) {
  const { valuationAction, estimatedValue, ...rest } = changes;
  const hasAmount = Object.prototype.hasOwnProperty.call(changes, "estimatedValue");
  const serviceChanged = changes.serviceNeeded !== undefined && changes.serviceNeeded !== lead.serviceNeeded;
  let value = {};
  if (valuationAction === "automatic") {
    const services = await ServiceOffering.find({ business: businessId, active: true }).lean();
    value = resolveOpportunityValue({ businessId, current: unknownEstimate(), services, evidence: changes.serviceNeeded || lead.serviceNeeded });
  } else if (hasAmount) value = ownerEstimate(estimatedValue, actorId);
  else if (serviceChanged && ["unknown", "service_catalog", "historical"].includes(lead.valuation?.source)) {
    const services = await ServiceOffering.find({ business: businessId, active: true }).lean();
    value = resolveOpportunityValue({ businessId, services, evidence: changes.serviceNeeded });
  }
  const update = { $set: { ...rest, ...value } };
  // Also invalidate analyses started before a manual service correction.
  if (hasAmount || valuationAction === "automatic" || serviceChanged) update.$inc = { valuationVersion: 1 };
  return Lead.findOneAndUpdate({ _id: lead._id, business: businessId }, update,
    { returnDocument: "after", runValidators: true }).populate("business", "businessName businessType phone");
}

// Valuation is ancillary: a valuation failure must never block a safety reply or SMS delivery.
export async function beginValuation(lead, businessId) {
  assertVoiceTurnActive(); assertDistributedLeaseActive();
  try { return await reserveValuation(lead, businessId); }
  catch (error) { safeConsole.error("opportunity.valuation_reservation_failed", { code: error.code || error.name }); return null; }
}
export async function finishValuation(ticket, context) {
  try { return await commitValuation(ticket, context); }
  catch (error) {
    if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
    safeConsole.error("opportunity.valuation_update_failed", { code: error.code || error.name }); return null;
  }
}
