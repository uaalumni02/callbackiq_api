# CallBackIQ Phase 9 API Tools — Test Discovery and Safety Fix v3

This bundle supersedes the earlier Phase 9 API tools.

It corrects two issues shown by the API test run:

1. Jest was discovering duplicate tests under `tools/api_overlay`.
2. `src/voice/voiceAgent.service.js` referenced a shared safety-assessment service that was not included in the installer overlay.

The v3 installer:

- adds `src/services/safetyAssessmentService.js`;
- reuses the existing `aiGuardrails.js` safety patterns;
- supports both `detectSafetyHazardTypes` and the older singular `detectSafetyHazardType` export;
- adds `<rootDir>/tools/api_overlay/` to Jest's `testPathIgnorePatterns`;
- adds a focused safety compatibility test;
- remains safe to run over an existing v2 installation.

From the API repository root:

```bash
unzip -o ~/Downloads/callbackiq_api_phase9_tools_v3.zip -d .
node tools/apply-phase9-api.mjs --dry-run
node tools/apply-phase9-api.mjs --install
npm run test:phase9
npm run certify:phase9
```

The dry run does not modify repository files. Existing changed files are backed up under `.callbackiq-backups`.
