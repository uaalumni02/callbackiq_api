#!/usr/bin/env node
// Read-only tenant diagnostics. No customer records, AI calls, or configuration writes.
import 'dotenv/config';
import mongoose from 'mongoose';
import Business from '../src/models/business.js';
import ServiceOffering from '../src/models/serviceOffering.js';
import Operations from '../src/models/businessOperationsSettings.js';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { evaluateServicePolicy, isBroadService } from '../src/services/serviceEligibility/policy.js';
import { formatApprovedServiceEstimate } from '../src/services/booking/serviceEstimatePolicy.js';
const args = process.argv.slice(2);
const arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const id = arg('--business-id'), name = arg('--business-name'), request = arg('--request');
if (Boolean(id) === Boolean(name) || (id && !mongoose.isValidObjectId(id))) {
  console.error('Use exactly one of --business-id OBJECT_ID or --business-name "Exact Business Name"; optionally --request "Customer service request".');
  process.exitCode = 1;
} else {
  try {
    await mongoose.connect(getMongoUrl(), { autoIndex: false, autoCreate: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
    const businesses = await Business.find(id ? { _id: id } : { businessName: name }).select('businessName businessType features').limit(2).maxTimeMS(5000).lean();
    if (businesses.length !== 1) throw new Error('Business not found or name is ambiguous; use its business ID.');
    const business = businesses[0];
    const [services, settings] = await Promise.all([
      ServiceOffering.find({business:business._id}).maxTimeMS(5000).lean(),
      Operations.findOne({business:business._id}).maxTimeMS(5000).lean(),
    ]);
    const offerings = services.map(service => ({
      id: String(service._id), name: service.name, category: service.category, active: service.active,
      broadScope: isBroadService(service), canDiscuss: service.aiCanDiscuss === true,
      canBook: service.aiCanBook === true, requiresHumanReview: service.requiresHumanReview === true,
      pricingEnabled: service.disclosePriceEstimate === true,
      priceRangeValid: Boolean(formatApprovedServiceEstimate(service)),
      diagnosticFeeEnabled: service.discloseDiagnosticFee === true,
      keywordCount: service.keywords?.length || 0, exclusions: service.excludedKeywords || [],
      issues: [service.disclosePriceEstimate && !formatApprovedServiceEstimate(service) ? 'Approved price disclosure requires a finite nonnegative minimum AND maximum, in order.' : '',
        service.requiresHumanReview && service.disclosePriceEstimate ? 'Service review must complete before automated pricing.' : '',
        service.aiCanBook && !service.aiCanDiscuss ? 'Booking is enabled but automated service discussion is disabled.' : ''].filter(Boolean),
    }));
    console.log(JSON.stringify({business:{id:String(business._id),name:business.businessName,type:business.businessType,aiBookingEnabled:business.features?.aiBookingEnabled===true},
      policy:settings?.serviceEligibilityPolicy || {}, canDiscussServices:settings?.aiPermissions?.canDiscussServices!==false,
      offerings, ...(request ? {requestDecision:evaluateServicePolicy({request,services,policy:settings?.serviceEligibilityPolicy || {}})} : {}),
      note:'A supported service and valid range do not certify live provider delivery, calendar access, or staff response.'},null,2));
  } catch(error) { console.error(`Audit failed: ${error.name || 'Error'}. Check connection and exact business selection.`); process.exitCode=1; }
  finally { await mongoose.disconnect(); }
}
