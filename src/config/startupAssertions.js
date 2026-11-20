export const assertStandaloneRuntime = (env = process.env) => {
  if (env.NODE_ENV === 'test' && !env.JEST_WORKER_ID) {
    throw new Error('NODE_ENV=test is reserved for Jest. Start MeekCall with NODE_ENV=development, staging, or production.');
  }
};
