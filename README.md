# CallBackIQ API

**Backend API and real-time recovery platform for CallBackIQ — AI-powered Voice + SMS call recovery for home-service businesses.**

The CallBackIQ API coordinates the systems that turn unanswered service calls into recoverable business opportunities. It manages authentication, tenant data, Twilio voice and messaging, AI-assisted qualification, scheduling, billing, trials, A2P readiness, real-time events, background workers, and operational safety controls.

> This repository contains the CallBackIQ backend. The customer-facing React application lives in the separate CallBackIQ frontend repository.

---

## What CallBackIQ Does

CallBackIQ is designed for home-service businesses that depend on phone calls for new revenue.

When a call is missed, abandoned, overflows, or arrives after hours, CallBackIQ can keep the customer moving toward a useful next step instead of letting the opportunity disappear.

```text
Incoming customer call
        ↓
Twilio voice handling / recovery decision
        ↓
Voice AI and/or SMS recovery
        ↓
Customer need, urgency, location, and timing captured
        ↓
Lead + conversation + call state persisted
        ↓
AI qualification and deterministic business rules
        ↓
Appointment, callback, transfer, or staff intervention
        ↓
Real-time updates to the CallBackIQ frontend
```

The platform is primarily designed for service businesses such as plumbing, HVAC, electrical, roofing, restoration, garage door, locksmith, landscaping, and similar call-driven trades.

---

## Core Responsibilities

The API owns the high-risk and stateful parts of CallBackIQ.

### Customer and business platform

- User authentication
- Business account management
- Tenant isolation
- Business configuration
- Lead management
- Customer conversations
- Message history
- Call logs
- Dashboard data
- Support workflows
- Administrative tools

### Telecom and recovery

- Twilio voice webhooks
- Twilio SMS webhooks
- Call-status processing
- Missed-call recovery
- Voice AI orchestration
- SMS qualification
- Tracking-number provisioning
- Messaging readiness
- A2P customer onboarding and event handling
- Delivery-state processing
- Communication limits and safety controls

### Scheduling

- Availability
- Appointment policy
- Appointment creation
- Internal scheduling
- Google Calendar integration
- Provider-neutral scheduling architecture
- Booking eligibility and safety checks

### Revenue and lifecycle

- Trials
- Subscription access
- Stripe Checkout / subscription lifecycle
- Stripe webhooks
- Revenue recovery
- Subscription integrity
- Customer lifecycle automation
- Billing safety and anomaly handling

### Real-time operations

- Authenticated Socket.IO connections
- Business-scoped events
- Dashboard refresh events
- Conversation/intervention updates
- Voice conversation relay
- Background automation and SMS workers

---

## Tech Stack

The backend is built with:

- **Node.js**
- **Express 5**
- **MongoDB**
- **Mongoose**
- **Socket.IO**
- **Twilio**
- **OpenAI**
- **Stripe**
- **Google APIs**
- **JSON Web Tokens**
- **Joi**
- **bcrypt**
- **Nodemailer**
- **Babel**
- **Jest**
- **Supertest**
- **mongodb-memory-server**
- Native Node test runner for additional hardening suites

The project uses ES modules.

---

## High-Level Architecture

```text
                         ┌──────────────────────┐
                         │  CallBackIQ Frontend │
                         └──────────┬───────────┘
                                    │
                           HTTPS / Socket.IO
                                    │
                         ┌──────────▼───────────┐
                         │    Express API       │
                         │  Auth + Tenant Layer │
                         └──────────┬───────────┘
                                    │
            ┌───────────────────────┼────────────────────────┐
            │                       │                        │
      ┌─────▼─────┐          ┌─────▼─────┐          ┌──────▼──────┐
      │  MongoDB  │          │  Workers  │          │  Socket.IO  │
      └───────────┘          └───────────┘          └─────────────┘
            │
   ┌────────┼──────────┬───────────┬──────────────┐
   │        │          │           │              │
 Twilio   OpenAI     Stripe     Google        Email/
 Voice +  AI          Billing    Calendar      Alerts
 SMS
```

The API is the source of truth for sensitive business state. Frontend validation is treated as a user-experience layer, not as the authorization boundary.

---

## API Route Groups

The Express application currently mounts the following primary route groups:

| Base path | Responsibility |
|---|---|
| `/api/health` | Health/readiness |
| `/api/auth` | Authentication |
| `/api/businesses` | Business data and onboarding |
| `/api/business-configuration` | Business recovery configuration |
| `/api/leads` | Leads |
| `/api/conversations` | Customer conversations |
| `/api/customers` | Customer recovery state |
| `/api/messages` | Messages |
| `/api/calls` | Call logs and call state |
| `/api/twilio` | Twilio voice/SMS webhooks and telecom operations |
| `/api/a2p-events` | A2P/compliance events |
| `/api/dashboard` | Dashboard data |
| `/api/admin` | Administrative operations |
| `/api/ai` | AI-assisted operations |
| `/api/alerts` | Alerts |
| `/api/agent` | Agent workflows |
| `/api/billing` | Billing and Stripe webhook handling |
| `/api/support` | Support |
| `/api/demo-requests` | Demo workflow |
| `/api/password-reset` | Password reset |
| `/api/conversation-intelligence` | Conversation intelligence |
| `/api/availability` | Scheduling availability |
| `/api/appointments` | Appointments |
| `/api/integrations` | Connected integrations |
| `/api/integration-webhooks` | Integration provider webhooks |
| `/api/automation` | Automation |
| `/api/analytics/revenue-recovery` | Revenue-recovery analytics |
| `/api/interventions` | Human intervention workflows |
| `/api/voice-settings` | Voice AI configuration |
| `/api/voice-operations` | Voice operations |

Exact endpoint contracts should be taken from the route/controller code and tests.

---

## Server Lifecycle

The production server:

1. Loads environment configuration.
2. Connects to MongoDB.
3. Starts the automation worker.
4. Starts the SMS processing worker.
5. Starts the HTTP server.
6. Initializes Socket.IO.
7. Initializes the voice conversation relay.
8. Handles graceful shutdown for HTTP, sockets, workers, voice relay, and MongoDB.

The default API port is:

```text
3000
```

Override it with the `PORT` environment variable.

---

## Local Development

### Prerequisites

Install or provide:

- A supported Node.js LTS release
- npm
- MongoDB
- Required provider accounts/credentials for the features you intend to run
- The CallBackIQ frontend for a complete local environment

### Install dependencies

```bash
npm install
```

### Configure environment

Create a local `.env` file containing the credentials and configuration required by your environment.

**Never commit real secrets.**

At a minimum, a full CallBackIQ environment may require configuration for:

- MongoDB
- JWT/authentication
- Frontend/CORS origins
- Twilio
- OpenAI
- Stripe
- Google OAuth / Calendar
- Email delivery
- Public webhook base URL
- A2P/compliance notifications
- Voice AI
- Operational limits and feature flags

Use the exact environment variable names referenced by the source and environment validation scripts in the current branch.

### Start the API in development

```bash
npm run start:dev
```

### Build

```bash
npm run build
```

### Start the compiled server

```bash
npm start
```

---

## Environment Security

The API uses credentials capable of sending communications, creating telecom resources, accessing billing systems, and processing customer data.

Treat the following classes of values as secrets:

- MongoDB connection strings
- JWT signing secrets
- Twilio Auth Tokens
- Twilio API Secrets
- Stripe secret keys
- Stripe webhook secrets
- OpenAI API keys
- Google OAuth client secrets
- OAuth refresh/access tokens
- Email provider credentials
- A2P event-stream credentials
- Internal signing/encryption keys

### Rules

- Never commit production `.env` files.
- Never paste secret values into README files.
- Never expose backend secrets to the React application.
- Use separate credentials for development and production when supported.
- Rotate credentials immediately if they are committed or otherwise exposed.
- Keep webhook verification enabled.
- Avoid logging tokens, passwords, authorization headers, or unnecessary customer content.

---

## Authentication and Tenant Isolation

CallBackIQ is a multi-tenant application.

Authentication and authorization must ensure that one business cannot access another business's:

- Leads
- Conversations
- Messages
- Calls
- Appointments
- Billing state
- Settings
- Voice sessions
- Socket events
- Customer data

The API uses authenticated request middleware and authenticated Socket.IO connections to enforce access.

Administrative functionality must remain explicitly role restricted.

---

## Twilio Voice and SMS

Twilio powers the telecom boundary of CallBackIQ.

The backend is responsible for:

- Voice webhooks
- SMS webhooks
- Call-status callbacks
- Outbound customer messaging
- Tracking-number behavior
- Voice AI routing
- Delivery/status processing
- Messaging readiness
- Signature validation
- Opt-out behavior
- Communication safety and limits

Twilio webhook payloads must be handled according to the provider's actual request format. Signature validation should fail closed for protected provider callbacks.

---

## A2P Messaging Readiness

Provisioning a phone number does not automatically mean the number is ready for application-to-person messaging.

CallBackIQ models messaging readiness separately so a business number can move through the required compliance and provider association state before SMS is treated as available.

The A2P layer is responsible for workflows such as:

- Customer/business onboarding state
- Approved campaign state
- Messaging Service association
- Sender/number association
- Compliance event processing
- Idempotent event handling
- Deregistration/failure handling
- Public readiness state for the frontend

SMS send paths should respect authoritative messaging readiness rather than assuming that a provisioned phone number can send.

---

## Voice AI

CallBackIQ supports a controlled Voice AI recovery path for calls that should not simply end when staff are unavailable.

Voice capabilities include infrastructure for:

- Overflow handling
- After-hours handling
- Callback-first recovery
- Customer intent capture
- Service-area checks
- Availability/booking interaction
- Human escalation and intervention
- Usage/capacity controls
- Voice-session lifecycle
- Conversation relay
- Recovery metrics

The voice system is designed to use deterministic safety and business rules around AI output rather than allowing the model to act as an unrestricted decision-maker.

---

## AI-Assisted Qualification

AI is used to help interpret customer messages and conversations, but important product behavior should remain bounded by deterministic application logic.

The backend should preserve:

- Structured output validation
- Malformed-response handling
- Safe fallbacks
- Capability restrictions
- Redaction/logging discipline
- Booking safety
- Communication limits
- Clear handoff to humans when the system should not proceed automatically

Tests should mock model calls where practical rather than depending on live OpenAI responses.

---

## Scheduling

CallBackIQ uses a provider-neutral scheduling model.

The API supports concepts such as:

- Business appointment policy
- Availability generation
- Slot validation
- Appointment creation
- Internal scheduling
- Google Calendar
- Provider abstraction
- Booking safety
- Idempotent booking behavior

This allows the customer recovery workflow to ask for a useful appointment time without tightly coupling the product to one calendar provider.

---

## Stripe Billing and Trial Lifecycle

Billing is a critical system boundary.

The backend owns:

- Subscription creation/access
- Trial lifecycle
- Checkout/session synchronization
- Subscription integrity
- Billing webhooks
- Customer billing state
- Duplicate/unordered webhook tolerance
- Canonical subscription handling
- Revenue-related access control

Billing changes should be treated as high risk and accompanied by targeted tests.

Stripe webhook handling is mounted before the normal JSON parsing pipeline where raw request-body access is required for signature verification.

---

## Webhooks

CallBackIQ consumes webhooks from external providers.

Important principles:

- Verify provider signatures.
- Preserve raw bodies where the provider requires them.
- Treat duplicate events as normal.
- Expect events to arrive out of order.
- Make processing idempotent.
- Avoid trusting frontend-provided provider state.
- Record enough state to diagnose failures without logging secrets.

The application mounts signature-sensitive billing/integration webhook routes before general body parsing where required.

---

## Socket.IO and Real-Time Events

The API initializes Socket.IO on the same HTTP server used by Express.

Socket connections are authenticated and associated with the correct business context before tenant-specific events are delivered.

Real-time features support:

- Dashboard refresh
- Conversation activity
- Lead/recovery changes
- Operational interventions
- Other business-scoped product events

When adding a new event, preserve tenant isolation and test that one business cannot receive another business's events.

---

## Background Workers

The server starts background processing for:

- Automation workflows
- SMS processing

Additional lifecycle, maintenance, sweep, migration, reconciliation, and cleanup operations are exposed through scripts.

Worker code should be designed for:

- Retry safety
- Reentrancy
- Idempotency
- Lease/ownership correctness where applicable
- Permanent failure handling
- Graceful shutdown

---

## Testing

CallBackIQ has multiple layers of automated testing.

### Full Jest suite

```bash
npm test
```

### Unit tests

```bash
npm run test:unit
```

### Integration/routes/services

```bash
npm run test:integration
```

### Coverage

```bash
npm run test:coverage
```

### Critical-path hardening

```bash
npm run test:critical
```

### Additional hardening tests

```bash
npm run test:hardening
```

### Replica-set concurrency test

```bash
npm run test:replica-set
```

### Canonical CI command

```bash
npm run test:ci
```

The CI command runs the core quality gate and replica-set suite.

The core CI path includes:

```text
repository hygiene
      ↓
coverage
      ↓
coverage risk report
      ↓
coverage ratchet
      ↓
diff coverage
      ↓
hardening tests
      ↓
build
```

---

## Coverage Strategy

Coverage is treated as a quality-control mechanism rather than a vanity metric.

The repository includes tooling for:

- Global coverage
- Coverage risk reporting
- Raise-only coverage ratchets
- Diff coverage
- Critical-path tests
- Targeted coverage-lift suites

High-risk areas deserve stronger direct testing, especially:

- Billing
- Subscription integrity
- Trials
- Twilio/webhooks
- A2P
- Authentication
- AI safety/fallback behavior
- Background workers
- Tenant isolation
- Scheduling/booking
- Voice recovery

A passing line-coverage number is not a substitute for testing failure branches, retries, duplicate events, event reordering, or authorization boundaries.

---

## Production-Readiness Commands

The repository includes dedicated verification and hardening commands.

Examples include:

```bash
npm run validate:env
npm run smoke:test
npm run verify:production-readiness
npm run test:production-readiness
npm run certify:production-readiness
```

There are also targeted certification and verification commands for voice functionality, onboarding, communication safety, and previously completed product phases.

---

## Performance Harnesses

The repository includes performance harnesses for important real-time/provider boundaries.

Examples:

```bash
npm run perf:webhook
npm run perf:socket
```

Performance tests should supplement correctness tests rather than replace them.

---

## Database Operations

The project includes operational scripts for database backup, restoration verification, migrations, backfills, and cleanup.

Examples:

```bash
npm run backup:db
npm run restore:verify
```

Migration or repair scripts should be reviewed carefully before being run against production data. Prefer dry-run behavior where available.

---

## Graceful Shutdown

The server handles shutdown by attempting to cleanly stop:

- Automation worker
- SMS processing worker
- Voice conversation relay
- Socket.IO
- HTTP server
- MongoDB connection

This is important for deploys, restarts, and worker correctness.

---

## Security Principles

Changes to the API should preserve these rules:

1. **Authenticate every protected request.**
2. **Authorize against the correct business/tenant.**
3. **Never trust the frontend as a security boundary.**
4. **Verify Twilio, Stripe, and integration webhook authenticity.**
5. **Keep secrets out of source control and logs.**
6. **Make external-event processing idempotent.**
7. **Fail safely when provider state is unknown.**
8. **Apply communication rate/usage limits.**
9. **Treat billing, telecom, and entitlement paths as high risk.**
10. **Test negative paths, not only successful requests.**

---

## Development Workflow

Before pushing significant API changes:

```bash
npm run test:ci
```

For high-risk changes, also run targeted suites relevant to the change.

A typical Git workflow:

```bash
git checkout development
git pull
git checkout -b feature/short-description

# make changes

npm run test:ci

git add .
git commit -m "feat: describe the change"
git push origin feature/short-description
```

---

## Repository Hygiene

The API contains scripts that enforce repository hygiene as part of CI.

Generated artifacts, local backups, credentials, coverage output, and other machine-specific files should not be committed unless intentionally required by the project.

Before pushing, verify:

```bash
git status
git diff --cached
```

Pay particular attention to:

- `.env`
- local backup folders
- coverage output
- temporary patch/update bundles
- logs
- credential files
- generated test artifacts

---

## Observability and Operations

Production operation should make it possible to identify failures across the recovery lifecycle without exposing sensitive data.

Useful operational signals include:

- Provider webhook failures
- SMS delivery failures
- Voice-session failures
- AI fallback rates
- A2P readiness failures
- Subscription inconsistencies
- Worker retries/failures
- Booking failures
- Socket authorization issues
- Recovery outcomes and latency

Logging should remain structured, useful, and privacy conscious.

---

## Product Philosophy

CallBackIQ is built around a simple principle:

**An unanswered call should still have a path to becoming booked revenue.**

The backend exists to make that path reliable across telecom providers, AI systems, billing, scheduling, real-time state, and human intervention.

---

## Repository Status

This repository contains active production-oriented CallBackIQ backend code.

Before merging changes that touch money, telecom, security, access control, customer messaging, or lifecycle state:

1. Review the failure paths.
2. Run targeted tests.
3. Run the CI command.
4. Confirm idempotency.
5. Confirm tenant isolation.
6. Confirm no credentials or sensitive artifacts are included.
7. Verify provider/webhook behavior against actual contracts when relevant.

---

**CallBackIQ — Voice AI + intelligent SMS recovery for home-service businesses.**


## Marketing Source → Revenue Attribution

CallBackIQ now treats marketing attribution as a measurement layer around the existing recovery engine rather than as a replacement for Voice AI or SMS.

The owner workflow remains **Home → Inbox → Appointments → Needs Attention → Settings**. Marketing attribution answers a different question: **where did every tracked call come from, what happened to it, and which opportunities did CallBackIQ recover?**

### Attribution model

- `MarketingSource` stores logical sources such as Google Ads, Google LSA, Google Business Profile, Facebook, Yelp, direct mail, referral, and other sources.
- `TrackingNumber` stores telephony resources separately from marketing sources. This keeps the model compatible with future number pools/DNI without coupling one source permanently to one number.
- `CallLog` is the authoritative attribution root because attribution is captured when the call arrives, before the final call outcome is known.
- `Lead.source` remains an operational channel field (`missed_call`, `sms`, `voice`, etc.). It is intentionally **not** reused as a marketing source.
- Appointments and conversion events store attribution references plus immutable snapshots so historical reports remain understandable after a source is renamed.
- Twilio routing is dual-read during migration: the new `TrackingNumber` mapping is checked first and the existing `Business.phone` mapping remains a compatibility fallback.
- Replies to a source-number conversation remain on that owned source number when it is active and messaging-ready.

### Owner APIs

`GET /api/marketing-sources` lists configured sources, source numbers, plan limits, and provisioning state.

`POST /api/marketing-sources` creates a source label.

`PATCH /api/marketing-sources/:id` updates a source.

`POST /api/marketing-sources/:id/tracking-number` assigns an additional Twilio source number. Source-number purchases are restricted to active paid subscriptions and require the primary number plus carrier messaging registration to be ready.

`GET /api/analytics/revenue-recovery/marketing-sources` returns all-call source performance including total calls, answered calls, missed calls, recovered calls, bookings, total booked value, and recovered value. The existing `/sources` endpoint remains available for operational/recovery-channel reporting.

### Compatibility migration

Run:

```bash
node scripts/backfill-primary-tracking-numbers.mjs
```

The migration mirrors each existing `Business.phone` into the new `TrackingNumber` collection. It does **not** remove or repurpose `Business.phone`; the legacy field stays in place during the compatibility period.

### Pricing

The customer-facing Pro price is now **$99/month** with a 14-day free trial. Pro includes the primary CallBackIQ recovery number and up to **3 additional marketing source tracking numbers** by default. The source-number limit can be changed with `ATTRIBUTION_INCLUDED_SOURCE_NUMBERS`.

**Stripe is authoritative for the actual amount charged.** Before deploying the $99 offer, create/select a recurring $99/month Stripe Price and set `STRIPE_PRO_PRICE_ID` to that Price ID. Changing UI copy does not modify an existing Stripe Price.

