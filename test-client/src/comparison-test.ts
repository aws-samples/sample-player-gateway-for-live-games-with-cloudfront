/**
 * Comparison Test for Gaming Gateway
 *
 * Sends identical traffic to both the Lambda and NGINX paths simultaneously,
 * then compares latency, error rates, and throughput side-by-side.
 *
 * Usage:
 *   npx ts-node src/comparison-test.ts --endpoint https://your-comparison-cf-domain.cloudfront.net
 *   npx ts-node src/comparison-test.ts --endpoint https://domain --rps 20 --duration 60
 */

import axios, { AxiosInstance } from 'axios';
import { program } from 'commander';

interface PathMetrics {
  name: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  latencies: number[];
  statusCodes: Record<number, number>;
}

const ENDPOINTS = [
  '/v1/auth/session',
  '/v1/profiles/me',
  '/v1/matchmaking/queue',
  '/v1/inventory/items',
  '/v1/config/game',
  '/health',
];

class ComparisonTester {
  private lambdaMetrics: PathMetrics = {
    name: 'Lambda (Serverless)',
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    latencies: [],
    statusCodes: {},
  };

  private nginxMetrics: PathMetrics = {
    name: 'NGINX (EC2 ASG)',
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    latencies: [],
    statusCodes: {},
  };

  private client: AxiosInstance;

  constructor(
    private baseUrl: string,
    private rps: number,
    private durationSeconds: number,
  ) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      validateStatus: () => true,
      headers: {
        'X-Game-Id': 'comparison-test',
        'X-Platform': 'pc',
        'X-Client-Version': '1.0.0',
        'Authorization': 'Bearer comparison-test-token',
      },
    });
  }

  async run(): Promise<void> {
    console.log('⚖️  Gaming Gateway - Architecture Comparison Test');
    console.log('==================================================');
    console.log(`   Endpoint:  ${this.baseUrl}`);
    console.log(`   RPS:       ${this.rps} (per path, ${this.rps * 2} total)`);
    console.log(`   Duration:  ${this.durationSeconds}s`);
    console.log(`   Paths:     /lambda/* vs /nginx/*`);
    console.log('');

    const startTime = Date.now();
    const endTime = startTime + this.durationSeconds * 1000;
    const intervalMs = 1000 / this.rps;

    let requestCount = 0;
    const activeRequests: Promise<void>[] = [];

    // Progress reporting
    const progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(
        `   📈 ${elapsed.toFixed(0)}s | Lambda: ${this.lambdaMetrics.successCount}ok/${this.lambdaMetrics.errorCount}err | NGINX: ${this.nginxMetrics.successCount}ok/${this.nginxMetrics.errorCount}err`,
      );
    }, 5000);

    while (Date.now() < endTime) {
      const endpoint = ENDPOINTS[requestCount % ENDPOINTS.length];

      // Send to both paths simultaneously
      const lambdaPromise = this.sendRequest(`/lambda${endpoint}`, this.lambdaMetrics);
      const nginxPromise = this.sendRequest(`/nginx${endpoint}`, this.nginxMetrics);

      activeRequests.push(lambdaPromise, nginxPromise);

      // Clean up completed promises
      if (activeRequests.length > 200) {
        await Promise.race(activeRequests);
        // Remove resolved promises
        const pending = activeRequests.filter(p => {
          let resolved = false;
          p.then(() => { resolved = true; }).catch(() => { resolved = true; });
          return !resolved;
        });
        activeRequests.length = 0;
        activeRequests.push(...pending);
      }

      requestCount++;
      await sleep(intervalMs);
    }

    // Wait for remaining
    await Promise.allSettled(activeRequests);
    clearInterval(progressInterval);

    // Print comparison report
    this.printReport();
  }

  private async sendRequest(path: string, metrics: PathMetrics): Promise<void> {
    const start = Date.now();
    metrics.totalRequests++;

    try {
      const response = await this.client.get(path);
      const latency = Date.now() - start;
      metrics.latencies.push(latency);
      metrics.statusCodes[response.status] = (metrics.statusCodes[response.status] || 0) + 1;

      if (response.status >= 200 && response.status < 500) {
        metrics.successCount++;
      } else {
        metrics.errorCount++;
      }
    } catch (error) {
      const latency = Date.now() - start;
      metrics.latencies.push(latency);
      metrics.errorCount++;
      metrics.statusCodes[0] = (metrics.statusCodes[0] || 0) + 1;
    }
  }

  private printReport(): void {
    console.log('\n\n');
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║           ARCHITECTURE COMPARISON RESULTS                           ║');
    console.log('╠══════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                      ║');

    const lambdaStats = this.computeStats(this.lambdaMetrics);
    const nginxStats = this.computeStats(this.nginxMetrics);

    // Header
    console.log(`║  Metric                │ Lambda (Serverless)  │ NGINX (EC2 ASG)      ║`);
    console.log(`║  ─────────────────────-┼──────────────────────┼──────────────────────║`);

    // Requests
    console.log(`║  Total Requests        │ ${pad(lambdaStats.total)}│ ${pad(nginxStats.total)}║`);
    console.log(`║  Success Rate          │ ${pad(lambdaStats.successRate)}│ ${pad(nginxStats.successRate)}║`);
    console.log(`║  Error Count           │ ${pad(lambdaStats.errors)}│ ${pad(nginxStats.errors)}║`);

    console.log(`║  ─────────────────────-┼──────────────────────┼──────────────────────║`);

    // Latency
    console.log(`║  Avg Latency           │ ${pad(lambdaStats.avgLatency)}│ ${pad(nginxStats.avgLatency)}║`);
    console.log(`║  P50 Latency           │ ${pad(lambdaStats.p50)}│ ${pad(nginxStats.p50)}║`);
    console.log(`║  P95 Latency           │ ${pad(lambdaStats.p95)}│ ${pad(nginxStats.p95)}║`);
    console.log(`║  P99 Latency           │ ${pad(lambdaStats.p99)}│ ${pad(nginxStats.p99)}║`);
    console.log(`║  Max Latency           │ ${pad(lambdaStats.max)}│ ${pad(nginxStats.max)}║`);

    console.log(`║  ─────────────────────-┼──────────────────────┼──────────────────────║`);

    // Throughput
    console.log(`║  Actual RPS            │ ${pad(lambdaStats.rps)}│ ${pad(nginxStats.rps)}║`);

    console.log('║                                                                      ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    // Winner determination
    console.log('\n   🏆 Comparison Summary:');

    const latencyWinner = lambdaStats.avgLatencyMs < nginxStats.avgLatencyMs ? 'Lambda' : 'NGINX';
    const latencyDiff = Math.abs(lambdaStats.avgLatencyMs - nginxStats.avgLatencyMs).toFixed(1);
    console.log(`      Latency:      ${latencyWinner} wins by ${latencyDiff}ms average`);

    const errorWinner = this.lambdaMetrics.errorCount <= this.nginxMetrics.errorCount ? 'Lambda' : 'NGINX';
    console.log(`      Reliability:  ${errorWinner} has fewer errors`);

    const p99Winner = lambdaStats.p99Ms < nginxStats.p99Ms ? 'Lambda' : 'NGINX';
    const p99Diff = Math.abs(lambdaStats.p99Ms - nginxStats.p99Ms).toFixed(1);
    console.log(`      Tail Latency: ${p99Winner} wins P99 by ${p99Diff}ms`);

    console.log('\n   📊 Check the CloudWatch dashboard for detailed time-series comparison.');
    console.log('      Dashboard: GamingGateway-Comparison-LambdaVsNginx');
  }

  private computeStats(metrics: PathMetrics) {
    const sorted = [...metrics.latencies].sort((a, b) => a - b);
    const total = sorted.length || 1;
    const avgMs = sorted.reduce((a, b) => a + b, 0) / total;

    return {
      total: metrics.totalRequests.toString(),
      successRate: `${(metrics.successCount / metrics.totalRequests * 100).toFixed(1)}%`,
      errors: metrics.errorCount.toString(),
      avgLatency: `${avgMs.toFixed(1)}ms`,
      avgLatencyMs: avgMs,
      p50: `${(sorted[Math.floor(total * 0.5)] || 0)}ms`,
      p95: `${(sorted[Math.floor(total * 0.95)] || 0)}ms`,
      p99: `${(sorted[Math.floor(total * 0.99)] || 0)}ms`,
      p99Ms: sorted[Math.floor(total * 0.99)] || 0,
      max: `${(sorted[total - 1] || 0)}ms`,
      rps: `${(metrics.totalRequests / this.durationSeconds).toFixed(1)}/s`,
    };
  }
}

function pad(value: string, width: number = 20): string {
  return value.padEnd(width);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI
program
  .name('comparison-test')
  .description('A/B comparison test: Lambda vs NGINX paths')
  .requiredOption('-e, --endpoint <url>', 'Comparison CloudFront endpoint URL')
  .option('-r, --rps <number>', 'Requests per second (per path)', '10')
  .option('-d, --duration <seconds>', 'Test duration in seconds', '30')
  .parse();

const opts = program.opts();

const tester = new ComparisonTester(
  opts.endpoint,
  parseInt(opts.rps),
  parseInt(opts.duration),
);

tester.run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
