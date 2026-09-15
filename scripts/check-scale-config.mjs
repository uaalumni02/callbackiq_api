import 'dotenv/config';
import { validateScaleProfile } from '../src/config/scaleProfile.js';
const result = validateScaleProfile();
console.log(JSON.stringify(result, null, 2));
if (!result.enabled || result.errors.length) process.exitCode = 1;
