import fs from 'node:fs/promises';
import { validateVoiceTopology } from '../src/config/voiceTopology.js';
try {
  const file = process.argv[2] || process.env.SCALE_DEPLOYMENT_FILE || 'scale-deployment.json';
  const result = validateVoiceTopology(JSON.parse(await fs.readFile(file, 'utf8')));
  console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
