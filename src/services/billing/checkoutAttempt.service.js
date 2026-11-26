import CheckoutAttempt from "../../models/checkoutAttempt.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { numericSetting } from "../../config/numericSettings.js";
const problem = (code, message) =>
  Object.assign(new Error(message), { code, statusCode: 409 });
const load = (business) =>
  CheckoutAttempt.findOne({ business }).select("+params");
const preserveTerminal = async (attempt, state) => {
  assertDistributedLeaseActive();
  const changed = await CheckoutAttempt.updateOne(
    { _id: attempt._id, generation: attempt.generation },
    { $set: { state } },
  );
  if (!changed.matchedCount)
    throw problem(
      "CHECKOUT_ATTEMPT_CHANGED",
      "Payment setup changed. Reload Billing.",
    );
  attempt.state = state;
};
const existingSession = async (stripe, attempt, purpose, params) => {
  if (!attempt.sessionId) return null;
  const session = await stripe.checkout.sessions.retrieve(attempt.sessionId);
  assertDistributedLeaseActive();
  if (
    session?.status === "open" &&
    session.id === attempt.sessionId &&
    attempt.purpose === purpose &&
    attempt.params?.line_items?.[0]?.price === params.line_items?.[0]?.price
  )
    return session;
  if (session?.status === "open") {
    const expired = await stripe.checkout.sessions.expire(session.id);
    if (expired?.status !== "expired")
      throw problem(
        "CHECKOUT_EXPIRATION_UNVERIFIED",
        "The previous payment link could not be retired.",
      );
    await preserveTerminal(attempt, "expired");
    return null;
  }
  if (!["complete", "expired"].includes(session?.status))
    throw problem(
      "CHECKOUT_RECONCILIATION_REQUIRED",
      "The previous payment must be reconciled before retrying.",
    );
  await preserveTerminal(attempt, session.status);
  return null;
};
const createRemote = async (stripe, attempt) => {
  const startedAt = new Date(attempt.attemptStartedAt).getTime();
  if (
    !Number.isFinite(startedAt) ||
    Date.now() - startedAt > numericSetting("PILOT_CHECKOUT_RETRY_WINDOW_MS")
  )
    throw problem(
      "CHECKOUT_RECONCILIATION_REQUIRED",
      "Contact support to reconcile the previous payment attempt.",
    );
  assertDistributedLeaseActive();
  const session = await stripe.checkout.sessions.create(attempt.params, {
    idempotencyKey: attempt.idempotencyKey,
  });
  assertDistributedLeaseActive();
  if (!session?.id || !session.url || session.status !== "open")
    throw problem(
      "CHECKOUT_RESULT_UNVERIFIED",
      "Payment setup could not be verified. No new attempt will be opened until it is reconciled.",
    );
  const changed = await CheckoutAttempt.updateOne(
    { _id: attempt._id, generation: attempt.generation, state: "creating" },
    { $set: { sessionId: session.id, url: session.url, state: "open" } },
  );
  if (!changed.matchedCount)
    throw problem(
      "CHECKOUT_ATTEMPT_CHANGED",
      "Payment setup changed. Reload Billing.",
    );
  return session;
};
/** Returns the one verified open session; terminal/expired attempts get a new durable generation. */
export async function openCheckoutAttempt({
  stripe,
  businessId,
  purpose,
  params,
}) {
  let attempt = await load(businessId);
  if (attempt?.sessionId) {
    const existing = await existingSession(stripe, attempt, purpose, params);
    if (existing) return existing;
  }
  if (attempt?.state === "creating") {
    if (attempt.purpose !== purpose)
      throw problem(
        "CHECKOUT_RECONCILIATION_REQUIRED",
        "The in-progress payment must finish before changing activation type.",
      );
    return createRemote(stripe, attempt);
  }
  const generation = (attempt?.generation || 0) + 1;
  const history = attempt
    ? [
        ...(attempt.history || []),
        {
          generation: attempt.generation,
          state: attempt.state,
          sessionId: attempt.sessionId,
        },
      ].slice(-20)
    : [];
  const fields = {
    business: businessId,
    generation,
    attemptStartedAt: new Date(),
    purpose,
    state: "creating",
    sessionId: "",
    url: "",
    params,
    history,
    idempotencyKey: `callbackiq:checkout:${businessId}:pro:${purpose}:attempt:${generation}`,
  };
  assertDistributedLeaseActive();
  attempt = await CheckoutAttempt.findOneAndUpdate(
    attempt
      ? { _id: attempt._id, generation: attempt.generation }
      : { business: businessId },
    { $set: fields },
    { upsert: !attempt, returnDocument: "after", runValidators: true },
  ).select("+params");
  if (!attempt)
    throw problem(
      "CHECKOUT_ATTEMPT_CHANGED",
      "Payment setup changed. Reload Billing.",
    );
  return createRemote(stripe, attempt);
}

/** Retires a pre-migration checkout before issuing any replacement; completed/unknown receipts block billing. */
export async function retireLegacyCheckout({ stripe, businessId, sessionId }) {
  if (!sessionId || (await CheckoutAttempt.exists({ business: businessId })))
    return;
  const previous = await stripe.checkout.sessions.retrieve(sessionId);
  assertDistributedLeaseActive();
  if (previous?.id !== sessionId)
    throw problem(
      "CHECKOUT_RECONCILIATION_REQUIRED",
      "The previous payment could not be verified.",
    );
  if (previous.status === "expired") return;
  if (previous.status !== "open")
    throw problem(
      "CHECKOUT_RECONCILIATION_REQUIRED",
      "Reconcile the previous payment before creating another link.",
    );
  const retired = await stripe.checkout.sessions.expire(sessionId);
  if (retired?.status !== "expired")
    throw problem(
      "CHECKOUT_EXPIRATION_UNVERIFIED",
      "The previous payment link could not be retired.",
    );
}
