import { persistReplyLeadFacts } from '../stateTransitions/messaging.js';
import { buildLeadUpdates } from './inboundLeadProjection.service.js';
import { finishValuation } from '../valuation/opportunityValuation.service.js';
import Lead from '../../models/lead.js';
import SocketService from '../socket.service.js';
export async function persistLeadReplyFacts({ business, lead, messages, customerTurn }, result, valuationTicket) {
  let updatedLead = lead;
  const leadUpdates = buildLeadUpdates(lead, result);
  if (Object.keys(leadUpdates).length) {
    updatedLead = await persistReplyLeadFacts({ Lead, lead, leadUpdates });
  }
  // Shared intake may already have saved the facts. Valuation must still finish.
  updatedLead = await finishValuation(valuationTicket, { businessId: business._id, evidence: [...messages.filter(message => message.direction === "inbound").map(message => message.body), customerTurn.customerMessage].join("\n"), proposedService: result.serviceNeeded || updatedLead.serviceNeeded }) || updatedLead;
  SocketService.emitLeadUpdated(business._id, updatedLead);
  return updatedLead;
}
