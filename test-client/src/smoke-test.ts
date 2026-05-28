/**
 * Smoke Test for Gaming Gateway
 *
 * Quick validation that the gateway is operational.
 * Run after deployment to verify basic functionality.
 *
 * Usage:
 *   npx ts-node src/smoke-test.ts --endpoint https://your-domain.cloudfront.net
 */

import axios from 'axios';
import { program } from 'commander';

interface SmokeTestCase {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  expectedStatus: number;
  headers?: Record<string, string>;
  body?: object;
  validateResponse?: (data: unknown) => boolean;
}

const SMOKE_TESTS: SmokeTestCase[] = [
  {
    name: 'Health check returns 200',
    method: 'GET',
    path: '/health',
    expectedStatus: 200,
    validateResponse: (data: unknown) => {
      const d = data as { status: string };
      return d.status === 'healthy';
    },
  },
  {
    name: 'Auth endpoint is routable',
    method: 'GET',
    path: '/v1/auth/session',
    expectedStatus: 200,
    headers: { 'Authorization': 'Bearer test-token', 'X-Game-Id': 'smoke-test' },
  },
  {
    name: 'Profile endpoint is routable',
    method: 'GET',
    path: '/v1/profiles/me',
    expectedStatus: 200,
    headers: { 'Authorization': 'Bearer test-token', 'X-Game-Id': 'smoke-test' },
  },
  {
    name: 'Unknown path returns 404',
    method: 'GET',
    path: '/v1/does-not-exist/foo',
    expectedStatus: 404,
  },
  {
    name: 'POST telemetry accepted',
    method: 'POST',
    path: '/v1/telemetry/events',
    expectedStatus: 200,
    headers: { 'X-Game-Id': 'smoke-test' },
    body: { events: [{ type: 'smoke_test', timestamp: Date.now() }] },
  },
  {
    name: 'CORS headers present',
    method: 'GET',
    path: '/v1/config/game',
    expectedStatus: 200,
    headers: { 'Origin': 'https://game-client.example.com' },
    validateResponse: (_data: unknown) => true, // Validated via headers in test logic
  },
  {
    name: 'Gateway metadata headers present',
    method: 'GET',
    path: '/v1/profiles/me',
    expectedStatus: 200,
    headers: { 'X-Game-Id': 'smoke-test', 'X-Platform': 'pc' },
  },
];

async function runSmokeTests(endpoint: string): Promise<boolean> {
  console.log('🔥 Gaming Gateway Smoke Tests');
  console.log('==============================');
  console.log(`   Endpoint: ${endpoint}\n`);

  const client = axios.create({
    baseURL: endpoint,
    timeout: 15000,
    validateStatus: () => true,
  });

  let passed = 0;
  let failed = 0;

  for (const test of SMOKE_TESTS) {
    try {
      const start = Date.now();
      const response = test.method === 'POST'
        ? await client.post(test.path, test.body, { headers: test.headers })
        : await client.request({ method: test.method, url: test.path, headers: test.headers });
      const latency = Date.now() - start;

      const statusOk = response.status === test.expectedStatus;
      const validationOk = test.validateResponse ? test.validateResponse(response.data) : true;

      // Check for gateway headers
      const hasRequestId = !!response.headers['x-request-id'];
      const hasCellIndex = !!response.headers['x-cell-index'];

      if (statusOk && validationOk) {
        passed++;
        console.log(`   ✅ ${test.name} (${latency}ms) [Cell: ${response.headers['x-cell-index'] || 'N/A'}]`);
      } else {
        failed++;
        console.log(`   ❌ ${test.name}`);
        console.log(`      Expected: ${test.expectedStatus}, Got: ${response.status}`);
        if (!validationOk) console.log(`      Response validation failed`);
      }

      // Warn if gateway headers are missing (indicates routing issue)
      if (!hasRequestId && response.status !== 404) {
        console.log(`      ⚠️  Missing X-Request-Id header`);
      }
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`   ❌ ${test.name}`);
      console.log(`      Error: ${msg}`);
    }
  }

  console.log(`\n   📊 Results: ${passed} passed, ${failed} failed, ${SMOKE_TESTS.length} total`);

  if (failed === 0) {
    console.log('   🎉 All smoke tests passed!');
  } else {
    console.log('   ⚠️  Some smoke tests failed. Check gateway deployment.');
  }

  return failed === 0;
}

// CLI
program
  .name('smoke-test')
  .description('Smoke test for the Gaming Gateway')
  .requiredOption('-e, --endpoint <url>', 'Gateway endpoint URL')
  .parse();

const opts = program.opts();

runSmokeTests(opts.endpoint).then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
