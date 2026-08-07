# Conversation Orchestration v2

CallbackIQ now treats every eligible inbound SMS as a bounded dispatcher workflow.

## Pipeline
Inbound SMS → deterministic safety checks → ConversationOrchestrator → booking state machine or AI qualification → structured outcome/memory → outbound response or explicit escalation.

## Production invariant
An eligible inbound customer SMS may not terminate silently. If the primary pipeline produces no reply and no escalation, CallbackIQ creates a high-priority alert and sends a safe fallback.

## Intelligent booking
Natural-language availability is recognized even when the customer does not use the words “book” or “schedule.” Calendar matching uses the existing scheduling provider. When a requested window is unavailable, the engine searches forward for up to three alternatives. After three no-match negotiations with no alternatives, the conversation escalates to the business with context.

## Structured memory
Conversation.conversationMemory stores the current summary, service, urgency, address, appointment preference, intent and confidence. Message.aiOutcome stores the per-inbound extraction and booking state for auditability and analytics.

## UX
The Conversations screen renders booking progress, a compact conversation summary, orchestration status and structured outcome details.
