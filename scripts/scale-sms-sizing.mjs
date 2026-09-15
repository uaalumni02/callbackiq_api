// Offline planning arithmetic. Input measured service time, not HTTP ACK time.
export function sizeSmsWorkers({ jobsPerSecond, processingP95Ms, lanes = 25, utilization = .65, spareReplicas = 1 }) {
  for (const value of [jobsPerSecond, processingP95Ms, lanes, utilization]) if (!Number.isFinite(value) || value <= 0) throw new Error('Sizing inputs must be positive measured numbers');
  if (!Number.isInteger(lanes) || lanes > 50 || utilization >= 1 || !Number.isInteger(spareReplicas) || spareReplicas < 0) throw new Error('Invalid lane, utilization, or spare replica configuration');
  const requiredReplicas = Math.ceil(jobsPerSecond * processingP95Ms / 1000 / (lanes * utilization)) + spareReplicas;
  return { requiredReplicas, lanesPerReplica: lanes, jobsPerSecond, processingP95Ms, utilization, spareReplicas,
    note: 'Conservative planning estimate; validate actual throughput, provider quotas and queue age in staging.' };
}
if (process.argv[1]?.endsWith('/scale-sms-sizing.mjs')) {
  const result = sizeSmsWorkers({ jobsPerSecond: Number(process.env.SCALE_SMS_JOBS_PER_SECOND), processingP95Ms: Number(process.env.SCALE_SMS_PROCESSING_P95_MS),
    lanes: Number(process.env.SMS_PROCESSING_CONCURRENCY || 25), utilization: Number(process.env.SCALE_SMS_TARGET_UTILIZATION || .65), spareReplicas: 1 });
  console.log(JSON.stringify(result, null, 2));
}
