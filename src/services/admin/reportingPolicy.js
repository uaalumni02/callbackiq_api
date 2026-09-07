export const DAY = 86400000;
export const WINDOWS = [7, 30, 90];
export const MISSED_STATUSES = [
  "missed",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
];
export const COST_CATEGORIES = [
  "sms",
  "voice",
  "ai",
  "numbers",
  "provider_other",
  "processing",
  "support",
];
export const OWNER_FIELDS =
  "userName email role businessName businessPhone businessType createdAt updatedAt";
export const BUSINESS_FIELDS =
  "metadata.isTest metadata.synthetic isTest businessName businessType owner phone email city state estimatedJobValue isActive createdAt updatedAt features voiceSettings.answerMode forwardingPhone trackingNumber.status trackingNumber.activatedAt messagingCompliance setupProgress";
export const SUBSCRIPTION_FIELDS =
  "business plan status isActive aiEnabled priceMonthly stripeSubscriptionId stripeCustomerId lastPaymentStatus trialStartedAt trialEndsAt trialUsedAt currentPeriodStart currentPeriodEnd cancelAtPeriodEnd createdAt";
export const rate = (numerator, denominator) => ({
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
});
export const cents = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Math.round(Number(value) * 100)
    : null;
export const date = (value) =>
  value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
export const inRange = (value, start, end) =>
  date(value) && date(value) >= start && date(value) < end;
export const ageDays = (value, now) =>
  date(value) ? Math.max(0, Math.floor((now - date(value)) / DAY)) : null;
// Match explicit fixture markers, never arbitrary customer names containing "test".
export const syntheticMatch = () => ({
  $or: [
    { "metadata.synthetic": true },
    { "metadata.isTest": true },
    { isTest: true },
    {
      notes:
        /synthetic (?:authorized )?load[ -]test|attributed synthetic|\[load-[^\]]+\]/i,
    },
    { summary: /synthetic (?:authorized )?load[ -]test|\[load-[^\]]+\]/i },
    ...["phone", "customerPhone", "from", "to"].map((key) => ({
      [key]: /^\+?1?\d{3}55501\d{2}$/,
    })),
  ],
});
export const realMatch = () => ({ $nor: syntheticMatch().$or });
export const billingState = (sub = {}, facts = [], now = new Date()) => {
  const evidence = facts.filter(
    (f) =>
      f.livemode === true &&
      f.currency === "usd" &&
      f.amountPaidCents > 0 &&
      f.paidAt,
  );
  const firstPaidAt =
    evidence
      .map((f) => date(f.paidAt))
      .filter(Boolean)
      .sort((a, b) => a - b)[0] || null;
  const providerBacked = Boolean(sub.stripeSubscriptionId);
  const paymentKnown = Boolean(firstPaidAt);
  const paid = providerBacked && paymentKnown && sub.status === "active";
  const amount = cents(sub.priceMonthly);
  return {
    status: sub.status || "none",
    plan: sub.plan || "none",
    paid,
    paymentKnown,
    firstPaidAt,
    mrrCents: paid ? amount : 0,
    priceKnown: amount !== null,
    monthlyPriceCents: amount,
    delinquentMrrCents:
      providerBacked && ["past_due", "unpaid"].includes(sub.status)
        ? amount
        : 0,
    scheduledCancellationMrrCents: paid && sub.cancelAtPeriodEnd ? amount : 0,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    currentPeriodEnd: sub.currentPeriodEnd || null,
    renewsWithin7Days:
      paid &&
      !sub.cancelAtPeriodEnd &&
      inRange(sub.currentPeriodEnd, now, new Date(+now + 7 * DAY)),
    trial: sub.status === "trialing" && date(sub.trialEndsAt) > now,
    trialStartedAt: sub.trialStartedAt || sub.trialUsedAt || null,
    trialEndsAt: sub.trialEndsAt || null,
    complimentaryOrUnbacked: !providerBacked && sub.status === "active",
  };
};
export const readinessState = (business, readiness, previous, now) => {
  const smsEnabled = business.features?.missedCallSmsEnabled !== false;
  const voiceEnabled =
    business.features?.voiceAiEnabled === true &&
    business.voiceSettings?.answerMode !== "disabled";
  const blockers = [];
  if (business.isActive === false)
    blockers.push({
      code: "access_suspended",
      message: "Account access is suspended",
    });
  if (smsEnabled && !readiness.states.smsRecoveryReady)
    blockers.push(...readiness.missingRequirements.smsRecovery);
  if (voiceEnabled && !readiness.states.voiceAiReady)
    blockers.push(...readiness.missingRequirements.voiceAi);
  if (
    business.features?.aiBookingEnabled === true &&
    !readiness.states.bookingReady
  )
    blockers.push(...readiness.missingRequirements.booking);
  if (!smsEnabled && !voiceEnabled)
    blockers.push({
      code: "no_recovery_mode",
      message: "No recovery mode is enabled",
    });
  const ready = blockers.length === 0;
  const code = blockers
    .map((b) => b.code)
    .sort()
    .join(",");
  const since = code
    ? previous?.blockerCode === code
      ? previous.blockerObservedAt
      : now
    : null;
  return {
    ready,
    smsReady: readiness.states.smsRecoveryReady,
    voiceReady: readiness.states.voiceAiReady,
    bookingReady: readiness.states.bookingReady,
    blockers,
    blockerCode: code,
    blockerObservedAt: since,
    blockerAgeDays: ageDays(since, now),
    firstReadyObservedAt:
      previous?.firstReadyObservedAt || (ready ? now : null),
    a2pStatus: readiness.messagingCompliance.a2pStatus,
    campaignStatus: readiness.messagingCompliance.campaignStatus,
    smsEnabled,
    voiceEnabled,
    bookingEnabled: business.features?.aiBookingEnabled === true,
  };
};
export const costSummary = (records, usage, now, recognizedRevenueCents) => {
  const items = COST_CATEGORIES.map((category) => {
    const row = records.find((r) => r.category === category);
    if (row)
      return {
        category,
        amountCents: row.amountCents,
        basis: row.basis,
        throughDate: row.throughDate,
        supportMinutes: row.supportMinutes || 0,
      };
    const estimate =
      category === "voice"
        ? usage.twilioEstimatedCostCents
        : category === "ai"
          ? usage.openAiEstimatedCostCents
          : null;
    return {
      category,
      amountCents: estimate > 0 ? estimate : null,
      basis: estimate > 0 ? "estimated_partial" : "missing",
      throughDate: null,
    };
  });
  // Month-to-date inputs must cover the same reporting cutoff. Positive ledger
  // values alone are partial evidence, never proof that all provider costs exist.
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const complete = items.every(
    (i) =>
      i.amountCents !== null &&
      date(i.throughDate) >= cutoff &&
      !["missing", "estimated_partial"].includes(i.basis),
  );
  const knownCostCents = items.reduce(
    (sum, item) => sum + (item.amountCents || 0),
    0,
  );
  const marginCents =
    complete && recognizedRevenueCents !== null
      ? recognizedRevenueCents - knownCostCents
      : null;
  return {
    items,
    knownCostCents,
    complete,
    marginCents,
    marginRate:
      marginCents !== null && recognizedRevenueCents > 0
        ? marginCents / recognizedRevenueCents
        : null,
    revenueCents: recognizedRevenueCents,
    supportMinutes: records.reduce(
      (sum, r) => sum + (r.supportMinutes || 0),
      0,
    ),
  };
};
export const actionsFor = (row, now) => {
  const result = [];
  const add = (priority, code, reason, action, since) =>
    result.push({
      priority,
      code,
      reason,
      action,
      since: since || null,
      ageDays: ageDays(since, now),
    });
  if (row.billing.paid && !row.readiness.ready)
    add(
      1,
      "paid_blocked",
      "Paying account cannot use its configured service",
      "Review activation blockers",
      row.readiness.blockerObservedAt,
    );
  if (row.health.billingAnomalies)
    add(
      1,
      "billing_anomaly",
      "Unresolved billing anomaly",
      "Review billing integrity records",
      null,
    );
  if (row.health.stuckWork)
    add(
      1,
      "stuck_work",
      `${row.health.stuckWork} stuck or failed recovery jobs`,
      "Inspect recovery processing",
      row.health.oldestWorkAt,
    );
  if (
    row.health.smsFailures ||
    row.health.callFailures ||
    row.health.bookingFailures ||
    row.health.integrationErrors
  )
    add(
      2,
      "service_failure",
      "Delivery, call, booking, or integration failures recorded",
      "Review service health and customer impact",
      null,
    );
  if (row.billing.delinquentMrrCents > 0)
    add(
      2,
      "payment",
      "Payment is overdue",
      "Review the customer's billing account",
      null,
    );
  if (
    row.billing.trial &&
    date(row.billing.trialEndsAt) <= new Date(+now + 3 * DAY) &&
    (!row.readiness.ready || !row.windows[30].bookings)
  )
    add(
      2,
      "trial",
      "Trial ends within 3 days without readiness or a confirmed booking",
      "Review remaining trial time and value",
      row.billing.trialStartedAt,
    );
  if (row.billing.cancelAtPeriodEnd)
    add(
      3,
      "cancellation",
      "Cancellation scheduled",
      "Review cancellation reason and contact history",
      null,
    );
  if (row.health.overdueTickets)
    add(
      3,
      "support",
      `${row.health.overdueTickets} open tickets waiting over 48 hours`,
      "Review customer support tickets",
      row.health.oldestTicketAt,
    );
  if (date(row.profile.followUpAt) && date(row.profile.followUpAt) < now)
    add(
      3,
      "follow_up",
      "Founder follow-up is overdue",
      row.profile.nextAction || "Review follow-up",
      row.profile.followUpAt,
    );
  if (
    row.billing.paid &&
    row.readiness.ready &&
    (!row.lastActivityAt || ageDays(row.lastActivityAt, now) >= 14)
  )
    add(
      4,
      "inactive",
      "No observed real activity in the last 14 days",
      "Check call forwarding and expected call volume",
      row.lastActivityAt,
    );
  return result;
};
