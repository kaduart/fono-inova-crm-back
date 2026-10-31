import { fileURLToPath } from 'node:url';
export default {
 root: fileURLToPath(new URL('./', import.meta.url)),
 test: {
  include: ['tests/integration/cancellationStatusFix.local.test.js'],
  environment: 'node', globals: false, setupFiles: [],
  testTimeout: 45000, hookTimeout: 60000, pool: 'forks', maxWorkers: 1,
  env: { NODE_ENV:'test', ENABLE_WORKERS:'false', ENABLE_CRONS:'false', ENABLE_PROJECTIONS:'false', MONGO_URI:'mongodb://127.0.0.1:1/blocked_test' },
 },
};
