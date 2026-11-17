// Exact previous transition and slot claim rules. No I/O.
export const ACTIVE_STATUSES = new Set(["held", "confirmed", "cancel_pending"]);
export const VALID_TRANSITIONS = {
  held: new Set(["confirmed", "failed", "canceled", "cancel_pending"]),
  confirmed: new Set(["canceled", "completed", "no_show", "rescheduled", "cancel_pending"]),
  cancel_pending: new Set(['canceled']),
  canceled: new Set(),
  completed: new Set(),
  no_show: new Set(),
  failed: new Set(),
  rescheduled: new Set(),
};




export const getSlotKey = (startAt, endAt) =>
  `${new Date(startAt).toISOString()}|${new Date(endAt).toISOString()}`;

export const getSlotClaimKeys = ({
  startAt,
  endAt,
  bufferBeforeMinutes = 0,
  bufferAfterMinutes = 0,
  capacityLane,
}) => {
  const minuteMs = 60_000;
  const claimStart =
    Math.floor(
      (new Date(startAt).getTime() - Number(bufferBeforeMinutes || 0) * minuteMs) /
        minuteMs,
    ) * minuteMs;
  const claimEnd =
    Math.ceil(
      (new Date(endAt).getTime() + Number(bufferAfterMinutes || 0) * minuteMs) /
        minuteMs,
    ) * minuteMs;
  const keys = [];

  for (let cursor = claimStart; cursor < claimEnd; cursor += minuteMs) {
    keys.push(`${new Date(cursor).toISOString()}|lane:${capacityLane}`);
  }

  return keys;
};

export const assertTransition = (from, to) => {
  if (!VALID_TRANSITIONS[from]?.has(to)) {
    const error = new Error(`Invalid appointment transition: ${from} → ${to}`);
    error.statusCode = 409;
    error.code = "INVALID_APPOINTMENT_TRANSITION";
    throw error;
  }
};

// Pending provider mutations retain capacity even after an ordinary hold expires.
export const activeAppointmentFilter = (now = new Date()) => ({
  status: { $in: [...ACTIVE_STATUSES] },
  $or: [
    { status: { $in: ['confirmed', 'cancel_pending'] } },
    { status: 'held', heldExpiresAt: { $gt: now } },
    { status: 'held', 'confirmationIntent.status': 'pending_provider' },
    { status: 'held', pendingRescheduleExternalAppointmentId: { $exists: true, $nin: [null, ''] } },
    { status: 'held', 'providerOperation.state': { $in: ['pending', 'applied'] } },
  ],
});
