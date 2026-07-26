import "dotenv/config";

import { validateEnvironment } from "../src/config/env.js";

try {
  const result = validateEnvironment();

  for (const warning of result.warnings) {
    console.warn(`Environment warning: ${warning}`);
  }

  console.log(
    `CallBackIQ environment is valid for ${result.environment}.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
