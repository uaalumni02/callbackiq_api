import { verifiedAmountExpression } from './opportunityValue.js';
// A linked appointment is the canonical job. Never add its lead/event copies.
// Match tenant as well as lead; include canceled/replaced rows to suppress stale lead fallback.
export const canonicalLeadValueStages = () => [
  { $lookup: { from: 'appointments', let: { leadId: '$_id', tenant: '$business' }, pipeline: [
    { $match: { $expr: { $and: [{ $eq: ['$lead', '$$leadId'] }, { $eq: ['$business', '$$tenant'] }] } } },
    ...canonicalAppointmentValueStages(),
    { $project: { status: 1, completedAt: 1, actualRevenue: 1, value: reportValueExpression } },
  ], as: '_valuationJobs' } },
  { $set: {
    _valuationResolved: true,
    _verifiedValue: { $cond: [{ $gt: [{ $size: '$_valuationJobs' }, 0] },
      { $let: { vars: { known: { $filter: { input: '$_valuationJobs', as: 'job', cond: { $and: [{ $eq: ['$$job.status', 'confirmed'] }, { $ne: ['$$job.value', null] }] } } } },
        in: { $cond: [{ $gt: [{ $size: '$$known' }, 0] }, { $sum: '$$known.value' }, null] } } },
      { $cond: [{ $eq: [{ $ifNull: ['$completedAt', null] }, null] }, verifiedAmountExpression, null] } ] },
    actualRevenue: { $cond: [{ $gt: [{ $size: '$_valuationJobs' }, 0] }, { $sum: { $map: { input: '$_valuationJobs', as: 'job', in: { $cond: [{ $eq: ['$$job.status', 'completed'] }, { $ifNull: ['$$job.actualRevenue', 0] }, 0] } } } }, '$actualRevenue'] },
    completedAt: { $cond: [{ $gt: [{ $size: '$_valuationJobs' }, 0] },
      { $cond: [{ $in: ['confirmed', '$_valuationJobs.status'] }, null, { $max: '$_valuationJobs.completedAt' }] }, '$completedAt'] },
  } },
];
export const reportValueExpression = { $cond: [{ $eq: ['$_valuationResolved', true] }, '$_verifiedValue', verifiedAmountExpression] };

export const reportCoverageGroup = {
 estimatedCount: { $sum: { $cond: [{ $ne: [reportValueExpression, null] }, 1, 0] } },
 unestimatedCount: { $sum: { $cond: [{ $eq: [reportValueExpression, null] }, 1, 0] } },
};

// An explicit appointment override wins; otherwise a linked owner override is current.
export const canonicalAppointmentValueStages = () => [
  { $lookup: { from: 'leads', let: { leadId: '$lead', tenant: '$business' }, pipeline: [
    { $match: { $expr: { $and: [{ $eq: ['$_id', '$$leadId'] }, { $eq: ['$business', '$$tenant'] }] } } },
    { $project: { estimatedValue: 1, valuation: 1 } },
  ], as: '_valuationOwner' } },
  { $set: { _valuationResolved: true, _verifiedValue: { $cond: [
    { $and: [{ $ne: ['$valuation.source', 'owner'] }, { $eq: [{ $arrayElemAt: ['$_valuationOwner.valuation.source', 0] }, 'owner'] }] },
    { $ifNull: [{ $arrayElemAt: ['$_valuationOwner.estimatedValue', 0] }, null] }, verifiedAmountExpression,
  ] } } },
];
