/**
 * Load Test for Gaming Gateway
 *
 * Simulates concurrent player traffic to validate:
 * - Cell-based routing distribution
 * - Rate limiting behavior
 * - Latency under load
 * - Error rates at scale
 *
 * Usage:
 *   npx ts-node src/load-test.ts --endpoint https://your-domain.cloudfront.net --rps 100 --duration 60
 */

import axios, { AxiosInstance } from 'axios';
import { program } from 'commander';

interface LoadTestConfig {
  endpoint: string;
  requestsPerSecond: number;
  durationSeconds: number;
  concurrency: number;
}

interface LoadTestMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  requestsPerSecond: number;
  cellDistribution: Record<string, number>;
  statusCodeDistribution: Record<number, number>;
  errorMessages: string[];
}

const ENDPOINTS = [
  '/v1/auth/session',
  '/v1/profiles/me',
  '/v1/matchmaking/queue',
  '/v1/inventory/items',
  '/v1/leaderboards/global',
  '/v1/config/game',
  '/v1/telemetry/events',
  '/v1/social/friends',
];

const PLATFORMS = ['pc', 'ps5', 'xbox', 'switch', 'mobile'];
const GAMES = ['ac-valhalla', 'r6-siege', 'far-cry-6', 'the-division-2', 'legacy-game'];

class LoadTester {
  private client: AxiosInstance;
  private latencies: number[] = [];
  private cellHits: Record<string, number> = {};
  private statusCodes: Record<number, number> = {};
  private errors: string[] = [];
  private successCount = 0;
  private failCount = 0;

  constructor(private config: LoadTestConfig) {
    this.client = axios.create({
      baseURL: config.endpoint,
      timeout: 30000,
      validateStatus: () => true,
    });
  }

  async run(): Promise<LoadTestMetrics> {
    console.log('⚡ Gaming Gateway Load Test');
    console.log('===========================');
    console.log(`   Endpoint:    ${this.config.endpoint}`);
    console.log(`   RPS Target:  ${this.config.requestsPerSecond}`);
    console.log(`   Duration:    ${this.config.durationSeconds}s`);
    console.log(`   Concurrency: ${this.config.concurrency}`);
    console.log('');

    const startTime = Date.now();
    const endTime = startTime + this.config.durationSeconds * 1000;
    const intervalMs = 1000 / this.config.requestsPerSecond;

    let requestCount = 0;
    const activeRequests: Promise<void>[] = [];

    // Progress reporting
    const progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const currentRps = requestCount / elapsed;
      console.log(
        `   📈 Progress: ${requestCount} requests | ${currentRps.toFixed(1)} RPS | ${this.successCount} ok | ${this.failCount} err`,
      );
    }, 5000);

    while (Date.now() < endTime) {
      // Respect concurrency limit
      if (activeRequests.length >= this.config.concurrency) {
        await Promise.race(activeRequests);
      }

      const promise = this.sendRequest().then(() => {
        const idx = activeRequests.indexOf(promise);
        if (idx > -1) activeRequests.splice(idx, 1);
      });
      activeRequests.push(promise);
      requestCount++;

      // Throttle to target RPS
      await sleep(intervalMs);
    }

    // Wait for remaining requests
    await Promise.allSettled(activeRequests);
    clearInterval(progressInterval);

    return this.computeMetrics();
  }

  private async sendRequest(): Promise<void> {
    const endpoint = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
    const game = GAMES[Math.floor(Math.random() * GAMES.length)];
    const platform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];

    const start = Date.now();

    try {
      const response = await this.client.get(endpoint, {
        headers: {
          'X-Game-Id': game,
          'X-Platform': platform,
          'X-Client-Version': '1.0.0',
          'Authorization': `Bearer load-test-token-${game}`,
        },
      });

      const latency = Date.now() - start;
      this.latencies.push(latency);

      const cellIndex = response.headers['x-cell-index'] || 'unknown';
      this.cellHits[cellIndex] = (this.cellHits[cellIndex] || 0) + 1;
      this.statusCodes[response.status] = (this.statusCodes[response.status] || 0) + 1;

      if (response.status >= 200 && response.status < 500) {
        this.successCount++;
      } else {
        this.failCount++;
      }
    } catch (error) {
      const latency = Date.now() - start;
      this.latencies.push(latency);
      this.failCount++;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (this.errors.length < 10) this.errors.push(msg);
    }
  }

  private computeMetrics(): LoadTestMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const total = sorted.length;

    const metrics: LoadTestMetrics = {
      totalRequests: total,
      successfulRequests: this.successCount,
      failedRequests: this.failCount,
      avgLatencyMs: Math.round(sorted.reduce((a, b) => a + b, 0) / total),
      p50LatencyMs: sorted[Math.floor(total * 0.5)] || 0,
      p95LatencyMs: sorted[Math.floor(total * 0.95)] || 0,
      p99LatencyMs: sorted[Math.floor(total * 0.99)] || 0,
      maxLatencyMs: sorted[total - 1] || 0,
      requestsPerSecond: total / this.config.durationSeconds,
      cellDistribution: this.cellHits,
      statusCodeDistribution: this.statusCodes,
      errorMessages: this.errors,
    };

    this.printReport(metrics);
    return metrics;
  }

  private printReport(metrics: LoadTestMetrics): void {
    console.log('\n\n📊 Load Test Results');
    console.log('====================');
    console.log(`   Total Requests:     ${metrics.totalRequests}`);
    console.log(`   Successful:         ${metrics.successfulRequests} (${(metrics.successfulRequests / metrics.totalRequests * 100).toFixed(1)}%)`);
    console.log(`   Failed:             ${metrics.failedRequests}`);
    console.log(`   Actual RPS:         ${metrics.requestsPerSecond.toFixed(1)}`);
    console.log('');
    console.log('   Latency:');
    console.log(`     Average:          ${metrics.avgLatencyMs}ms`);
    console.log(`     P50:              ${metrics.p50LatencyMs}ms`);
    console.log(`     P95:              ${metrics.p95LatencyMs}ms`);
    console.log(`     P99:              ${metrics.p99LatencyMs}ms`);
    console.log(`     Max:              ${metrics.maxLatencyMs}ms`);
    console.log('');
    console.log('   Cell Distribution:');
    for (const [cell, count] of Object.entries(metrics.cellDistribution)) {
      const pct = (count / metrics.totalRequests * 100).toFixed(1);
      console.log(`     Cell ${cell}: ${count} requests (${pct}%)`);
    }
    console.log('');
    console.log('   Status Codes:');
    for (const [code, count] of Object.entries(metrics.statusCodeDistribution)) {
      console.log(`     ${code}: ${count}`);
    }

    if (metrics.errorMessages.length > 0) {
      console.log('');
      console.log('   Errors (first 10):');
      for (const err of metrics.errorMessages) {
        console.log(`     ❌ ${err}`);
      }
    }

    // Pass/Fail criteria
    console.log('\n   Verdict:');
    const p99Ok = metrics.p99LatencyMs < 5000;
    const errorRateOk = metrics.failedRequests / metrics.totalRequests < 0.01;
    console.log(`     P99 < 5s:         ${p99Ok ? '✅ PASS' : '❌ FAIL'} (${metrics.p99LatencyMs}ms)`);
    console.log(`     Error Rate < 1%:  ${errorRateOk ? '✅ PASS' : '❌ FAIL'} (${(metrics.failedRequests / metrics.totalRequests * 100).toFixed(2)}%)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI
program
  .name('load-test')
  .description('Load test for the Gaming Gateway')
  .requiredOption('-e, --endpoint <url>', 'Gateway endpoint URL')
  .option('-r, --rps <number>', 'Requests per second', '50')
  .option('-d, --duration <seconds>', 'Test duration in seconds', '30')
  .option('-c, --concurrency <number>', 'Max concurrent requests', '100')
  .parse();

const opts = program.opts();

const config: LoadTestConfig = {
  endpoint: opts.endpoint,
  requestsPerSecond: parseInt(opts.rps),
  durationSeconds: parseInt(opts.duration),
  concurrency: parseInt(opts.concurrency),
};

const tester = new LoadTester(config);
tester.run().then(metrics => {
  const errorRate = metrics.failedRequests / metrics.totalRequests;
  if (errorRate > 0.01 || metrics.p99LatencyMs > 5000) {
    process.exit(1);
  }
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
