// Synthetic evidence used only by unit tests; never release evidence.
export const capacityFixture = () => ({ schemaVersion: 1, apiSha: 'a'.repeat(40), providerMode: 'live',
  observedAt: new Date().toISOString(), observedBy: 'unit-test', evidenceRef: 'synthetic',
  target: { businesses: 1001, voiceSessions: 350, smsPerSecond: 200 }, utilization: .65,
  smsSamples: ['normal', 'slow-provider'].map(scenario => ({ scenario, completedJobs: 1000, durationMs: 300000, processingP95Ms: 2000, evidenceRef: 'synthetic' })),
  providerDemand: { otherAiRequestsPerMinute: 0, otherAiTokensPerMinute: 0, otherAiConcurrent: 0, aiRequestsPerSms: 1, aiTokensPerSms: 1000, voiceTurnsPerSecond: 35, aiRequestsPerVoiceTurn: 1, aiTokensPerVoiceTurn: 1000, smsSegmentsPerJob: 1 },
  providerQuota: { aiRequestsPerMinute: 100000, aiTokensPerMinute: 100000000, smsSegmentsPerSecond: 1000, voiceSessions: 450, aiConcurrent: 2000, observedAt: new Date().toISOString(), evidenceRef: 'synthetic' },
});
