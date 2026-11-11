import OpenAI from 'openai';
import Stripe from 'stripe';
import twilio from 'twilio';

// Keep latency/retry policy explicit at each purpose-specific call site.
export const createOpenAIClient = (purpose, options) => {
  if (!purpose) throw new Error('An AI client purpose is required');
  return new OpenAI(options);
};
export const createStripeClient = (key, options = {}) => new Stripe(key, options);
export const createTwilioClient = (...options) => twilio(...options);
