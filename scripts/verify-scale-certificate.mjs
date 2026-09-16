import { verifyScaleCertificate } from '../perf/certificate.mjs';
try {
  const result = await verifyScaleCertificate(process.env.SCALE_EVIDENCE_DIR || 'scale-evidence');
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ passed: false, errors: [error.message] }));
  process.exitCode = 1;
}
