const terminal = new Set(['booked', 'lost', 'spam']);
const urgencyRank = { low: 0, medium: 1, high: 2, emergency: 3 };
const fields = ['aiExtraction', 'serviceNeeded', 'urgency', 'address', 'preferredAppointmentTime', 'leadQualityScore', 'summary'];

// Automatic qualification owns proposed facts, never a staff lifecycle decision.
export function qualificationChanges(observed, proposed) {
  const changes = Object.fromEntries(fields.filter(field => proposed[field] !== undefined).map(field => [field, proposed[field]]));
  changes.status = terminal.has(observed.status) ? observed.status : 'contacted';
  if ((urgencyRank[changes.urgency] ?? -1) < (urgencyRank[observed.urgency] ?? -1)) changes.urgency = observed.urgency;
  return changes;
}

export function assertQualificationSnapshot(observed, id, businessId) {
  if (!observed || !businessId || String(observed._id) !== String(id) ||
    String(observed.business?._id || observed.business) !== String(businessId)) {
    throw Object.assign(new Error('The qualification snapshot does not match the lead and business.'), {
      code: 'TENANT_CONTEXT_REQUIRED', statusCode: 403,
    });
  }
}
