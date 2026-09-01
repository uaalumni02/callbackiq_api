# CallBackIQ API

CallBackIQ is an AI-powered call recovery, scheduling, marketing attribution, and revenue visibility platform for home-service businesses.

This repository contains the backend API and operational services responsible for authentication, tenant isolation, Voice AI, SMS recovery, customer qualification, appointments, marketing attribution, revenue recovery, telecom provisioning, A2P messaging readiness, trials, Stripe billing, provider integrations, real-time events, background workers, and production safety controls.

The customer-facing React application lives in the separate `callbackiq_frontend` repository.

---

## Product Overview

CallBackIQ helps call-driven service businesses prevent unanswered opportunities from automatically becoming lost revenue.

```text
Customer calls a CallBackIQ number
              ↓
Business / tracking source identified
              ↓
Call-routing policy evaluated
              ↓
Staff / Voice AI / overflow / after-hours
              ↓
Voice AI and/or SMS recovery
              ↓
Service need + urgency + location + timing
              ↓
Lead + conversation + call state
              ↓
Business rules + AI-assisted interpretation
              ↓
Appointment / callback / transfer / intervention
              ↓
Marketing attribution + business outcome
              ↓
Recovered revenue visibility
```

The platform is primarily designed for plumbing, HVAC, electrical, roofing, restoration, garage door, locksmith, landscaping, and similar call-driven home-service businesses.

---

## Core Platform Responsibilities

### Authentication and Tenant Isolation

The API manages:

- Registration
- Login
- Session validation
- Logout
- Email verification
- Verification resend
- Password reset
- Role authorization
- Business ownership
- Tenant isolation
- Authentication and abuse-rate controls

One business must never be able to access another business's customer, telecom, scheduling, revenue, billing, settings, or real-time data.

### Business Configuration

The platform stores and enforces business-specific configuration including:

- Business identity
- Business type
- Forwarding phone
- CallBackIQ/tracking numbers
- Timezone
- Business hours
- Service-area rules
- SMS templates
- Voice AI settings
- Recovery behavior
- Scheduling policy
- Integration configuration

---

## Voice AI

CallBackIQ supports controlled Voice AI workflows including:

- Overflow answering
- After-hours answering
- Always-on Voice AI
- Callback-first recovery
- Customer-intent capture
- Service qualification
- Service-area evaluation
- Appointment conversations
- Human escalation
- Transfer workflows
- Voice-session lifecycle
- Conversation relay
- Voice capacity and usage controls
- Recovery metrics

AI output is bounded by deterministic business and safety rules rather than treated as unrestricted automation.

---

## SMS Recovery

The backend manages:

- Missed-call recovery SMS
- Voice-to-SMS continuation
- Customer qualification
- Message persistence
- AI-assisted replies
- Manual messaging
- Delivery-state processing
- Opt-out behavior
- Messaging readiness
- Communication limits
- SMS safety rules
- Provider webhook processing

Voice and SMS can participate in the same customer recovery journey.

---

## AI-Assisted Qualification

AI can help interpret:

- Service need
- Urgency
- Customer intent
- Location
- Preferred timing
- Scheduling context
- Conversation context

Important actions remain constrained by application rules.

The backend preserves structured-output validation, safe fallbacks, malformed-response handling, booking restrictions, communication limits, and human handoff.

Automated tests should normally mock live model calls where practical.

---

## Scheduling and Appointments

CallBackIQ uses a provider-neutral scheduling model.

Capabilities include:

- Business appointment policy
- Business-hours enforcement
- Availability generation
- Slot validation
- Appointment holds
- Appointment requests
- Business approval
- Confirmation
- Rescheduling
- Cancellation
- Internal scheduling
- Google Calendar integration
- Provider abstraction
- Idempotent booking behavior

A customer's requested time must satisfy authoritative availability and business rules before confirmation.

---

## Human Intervention

The backend supports human-intervention workflows for circumstances where automation should stop.

Examples include:

- Urgent customer needs
- Escalations
- Booking exceptions
- Safety concerns
- Conversations requiring business judgment
- Recovery states requiring staff action

These workflows are surfaced in the frontend Intervention Center.

---

## Marketing Attribution

Marketing attribution measures where tracked calls came from and what happened after the call.

The platform separates:

- `MarketingSource`
- `TrackingNumber`
- `CallLog`
- `Lead`
- `Appointment`
- Conversion/revenue state

This allows attribution to be captured when the call arrives, before the final business outcome is known.

Example sources include:

- Google Ads
- Google Local Services Ads
- Google Business Profile
- Facebook
- Yelp
- Direct mail
- Referral
- Other configured sources

The primary CallBackIQ recovery number remains separate from optional marketing-source tracking numbers.

The current Pro product model includes:

- 1 primary CallBackIQ recovery number
- Up to 3 additional marketing-source tracking numbers by default

Current owner-facing attribution functionality includes APIs such as:

```text
GET   /api/marketing-sources
POST  /api/marketing-sources
PATCH /api/marketing-sources/:id
POST  /api/marketing-sources/:id/tracking-number
```

Marketing-source reporting is also available through revenue-recovery analytics.

---

## Revenue Recovery

CallBackIQ tracks business outcomes associated with recovery activity.

Reporting can include:

- Total calls
- Answered calls
- Missed calls
- Recovered calls
- Leads
- Appointments
- Recovery channel
- Marketing source
- Estimated value
- Actual revenue
- Recovered revenue

Revenue should only be reported when supported by authoritative platform data.

---

## Twilio and Telecom

The backend owns:

- Voice webhooks
- SMS webhooks
- Call-status callbacks
- Tracking-number routing
- Outbound SMS
- Voice AI routing
- Phone-number provisioning
- Delivery-state handling
- Messaging readiness
- Signature validation
- Opt-out enforcement
- Communication limits
- Usage/capacity controls

Provider webhook authenticity must be validated and protected telecom callbacks should fail safely when verification fails.

---

## A2P Messaging Readiness

Phone-number provisioning and SMS readiness are separate states.

CallBackIQ models messaging readiness through workflows including:

- Business/customer onboarding
- Campaign state
- Messaging Service association
- Sender association
- Compliance events
- Registration failure states
- Idempotent reconciliation
- Deregistration/failure handling
- Public readiness state

A number must not be treated as SMS-ready merely because it has been provisioned.

---

## Trial and Billing

Current customer-facing terms include:

- **14-day free trial**
- **No credit card required for the trial**
- **CallBackIQ Pro: $99/month**

The backend owns authoritative trial, entitlement, subscription, and billing state.

Responsibilities include:

- Trial eligibility
- Trial activation
- Subscription access
- Stripe Checkout
- Stripe webhook processing
- Subscription integrity
- Canonical subscription state
- Duplicate/out-of-order event handling
- Cancellation
- Resume/reactivation behavior
- Billing anomaly protection
- Revenue-related access controls

**Stripe is authoritative for the amount actually charged.**

Production `STRIPE_PRO_PRICE_ID` must reference the intended recurring Stripe Price. Updating documentation or UI copy does not alter Stripe pricing.

---

## Real-Time Operations

CallBackIQ uses authenticated Socket.IO communication for business-scoped real-time updates including:

- Dashboard activity
- Lead changes
- Conversation updates
- Recovery-state changes
- Intervention activity

Redis-backed Socket.IO scaling is supported where configured.

---

## Background Processing

Background and maintenance processing includes areas such as:

- Automation workflows
- SMS processing
- A2P reconciliation
- Trial lifecycle
- Integration maintenance
- Voice-session maintenance
- Communication reservation cleanup
- Customer lifecycle tasks
- Database migrations
- Backfills
- Operational cleanup

Workers should preserve idempotency, retry safety, reentrancy, lease/ownership correctness, permanent-failure handling, and graceful shutdown.

---

## High-Level Architecture

```text
                    CallBackIQ Frontend
                           │
                    HTTPS / Socket.IO
                           │
                  ┌────────▼────────┐
                  │   Express API   │
                  │ Auth + Tenant   │
                  │ Business Rules  │
                  └────────┬────────┘
                           │
       ┌───────────────────┼────────────────────┐
       │                   │                    │
    MongoDB             Workers             Socket.IO
       │
       ├──────── Twilio Voice + SMS
       ├──────── OpenAI
       ├──────── Stripe
       ├──────── Google Calendar
       └──────── Email / operational services
```

The API is the authoritative source for sensitive and stateful product behavior.

---

## Technology

The backend currently uses:

- Node.js
- Express 5
- MongoDB
- Mongoose
- Socket.IO
- Redis Socket.IO adapter support
- Twilio
- OpenAI
- Stripe
- Google APIs
- JSON Web Tokens
- Joi
- bcrypt
- Nodemailer
- Babel
- Jest
- Supertest
- mongodb-memory-server
- Native Node testing for additional hardening suites

The project uses ES modules.

---

## Major API Areas

| Base path | Responsibility |
|---|---|
| `/api/auth` | Authentication and verification |
| `/api/businesses` | Business account data |
| `/api/business-configuration` | Recovery/business configuration |
| `/api/leads` | Leads |
| `/api/conversations` | Conversations |
| `/api/messages` | Messaging |
| `/api/calls` | Call activity |
| `/api/twilio` | Telecom webhooks and operations |
| `/api/dashboard` | Dashboard data |
| `/api/appointments` | Appointment workflows |
| `/api/availability` | Scheduling availability |
| `/api/integrations` | Provider integrations |
| `/api/automation` | Automation |
| `/api/interventions` | Human intervention |
| `/api/conversation-intelligence` | Conversation intelligence |
| `/api/marketing-sources` | Marketing-source attribution |
| `/api/analytics/revenue-recovery` | Revenue-recovery analytics |
| `/api/billing` | Trial, subscription, and Stripe workflows |
| `/api/voice-settings` | Voice AI configuration |
| `/api/voice-operations` | Voice operations |
| `/api/admin` | Administrative operations |

Exact contracts should be taken from the current route, controller, service, and automated-test code.

---

## Local Development

Install dependencies:

```bash
npm install
```

Configure the required local `.env` values.

Never commit real credentials.

Start development mode:

```bash
npm run start:dev
```

Build:

```bash
npm run build
```

Start the compiled API:

```bash
npm start
```

The API normally uses port `3000` unless overridden with `PORT`.

---

## Testing

Run the complete Jest suite:

```bash
npm test
```

Unit tests:

```bash
npm run test:unit
```

Integration, route, and service tests:

```bash
npm run test:integration
```

Coverage:

```bash
npm run test:coverage
```

Critical-path testing:

```bash
npm run test:critical
```

Hardening:

```bash
npm run test:hardening
```

Replica-set concurrency:

```bash
npm run test:replica-set
```

Canonical CI gate:

```bash
npm run test:ci
```

Provider and production safety:

```bash
npm run test:provider-safety
npm run test:provider-contracts
npm run test:production-certification
```

Voice and concurrency:

```bash
npm run test:voice-hardening
npm run test:voice-concurrency
npm run perf:voice:webhook
npm run perf:voice:capacity
npm run perf:voice:relay
```

---

## Production Verification

Production-oriented commands include:

```bash
npm run validate:env
npm run smoke:test
npm run verify:production-readiness
npm run certify:production-readiness
npm run release:gate
npm run release:certify
```

---

## Environment Security

Never commit production credentials.

Sensitive values can include:

- MongoDB connection strings
- JWT signing secrets
- Twilio credentials
- Stripe secret keys
- Stripe webhook secrets
- OpenAI API keys
- Google OAuth client secrets
- OAuth access/refresh tokens
- Email credentials
- Internal signing/encryption keys

Keep backend secrets out of the React application and out of logs.

---

## Security Principles

Changes should preserve these rules:

1. Authenticate every protected request.
2. Authorize against the correct business.
3. Preserve strict tenant isolation.
4. Never trust the frontend as a security boundary.
5. Verify provider webhooks.
6. Keep secrets out of source control and logs.
7. Make external-event handling idempotent.
8. Apply communication limits and safety controls.
9. Treat telecom, billing, and entitlement paths as high risk.
10. Test negative paths as aggressively as successful paths.

---

## Product Principle

**An unanswered call should still have a path to becoming booked revenue.**

The backend exists to make that path reliable across telecom, AI, customer messaging, scheduling, attribution, billing, real-time state, and human intervention.

---

**CallBackIQ — Voice AI, SMS recovery, scheduling, marketing attribution, and revenue visibility for home-service businesses.**
