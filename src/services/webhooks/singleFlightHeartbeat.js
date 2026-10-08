// A slow database renewal must not queue more renewals behind itself. The
// caller's lease token/status filters still decide whether a renewal may write.
export function startSingleFlightHeartbeat({ res, intervalMs, renew, onError }) {
  let stopped = false;
  let inFlight = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    res.removeListener("finish", stop);
    res.removeListener("close", stop);
  };
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await renew();
    } catch (error) {
      onError(error);
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  res.once("finish", stop);
  res.once("close", stop);
  return timer;
}
