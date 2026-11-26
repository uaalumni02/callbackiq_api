import crypto from 'node:crypto';
import {numericSetting} from '../config/numericSettings.js';
import OpenAI from 'openai';
import Stripe from 'stripe';
import twilio from 'twilio';

// Keep latency/retry policy explicit at each purpose-specific call site.
export const createOpenAIClient = (purpose, options) => {
  if (!purpose) throw new Error('An AI client purpose is required');
  const client = new OpenAI({...options,maxRetries:0});
  const dispatch = client.responses.create.bind(client.responses);
  client.responses.create = async (...args) => {
    if (purpose !== 'companyExpenses') {
      const {assertProviderEntitlement,providerBusinessId}=await import('../services/providerEntitlement.service.js');
      const {reserveProviderBudget}=await import('../services/budgets/providerBudget.service.js');
      await assertProviderEntitlement(undefined, 'ai');
      await reserveProviderBudget({businessId:providerBusinessId(),metric:'ai',key:crypto.randomUUID()});
      await assertProviderEntitlement(undefined, 'ai');
      args[0]={...args[0],max_output_tokens:Math.min(args[0]?.max_output_tokens || 700,numericSetting('PILOT_AI_MAX_OUTPUT_TOKENS'))};
    }
    return dispatch(...args);
  };
  return client;
};
export const createStripeClient = (key, options = {}) => new Stripe(key, options);
export const createTwilioClient = (...options) => twilio(...options);
