/**
 * Gaming Gateway Test Client
 *
 * Simulates game client traffic patterns against the gateway.
 * Supports multiple game profiles, platforms, and traffic patterns.
 *
 * Usage:
 *   npx ts-node src/index.ts --endpoint https://your-cloudfront-domain.cloudfront.net
 *   npx ts-node src/index.ts --endpoint http://localhost:3000 --game assassins-creed --platform ps5
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { program } from 'commander';

interface GameProfile {
  gameId: string;
  name: string;
  platform: string;
  clientVersion: string;
  endpoints: string[];
}

// Simulated game profiles representing different client types
const GAME_PROFILES: GameProfile[] = [
  {
    gameId: 'ac-valhalla',
    name: 'Assassins Creed Valhalla',
    platform: 'ps5',
    clientVersion: '2.1.0',
    endpoints: ['/v1/auth/session', '/v1/profiles/me', '/v1/inventory/items', '/v1/leaderboards/global'],
  },
  {
    gameId: 'r6-siege',
    name: 'Rainbow Six Siege',
    platform: 'pc',
    clientVersion: '8.4.2',
    endpoints: ['/v1/auth/session', '/v1/matchmaking/queue', '/v1/profiles/stats', '/v1/social/friends'],
  },
  {
    gameId: 'far-cry-6',
    name: 'Far Cry 6',
    platform: 'xbox',
    clientVersion: '1.5.1',
    endpoints: ['/v1/auth/session', '/v1/config/game', '/v1/telemetry/events', '/v1/store/offers'],
  },
  {
    gameId: 'the-division-2',
    name: 'The Division 2',
    platform: 'pc',
    clientVersion: '3.2.0',
    endpoints: ['/v1/auth/session', '/v1/matchmaking/group', '/v1/inventory/stash', '/v1/social/clan'],
  },
  {
    gameId: 'legacy-game',
    name: 'Legacy Title (15+ years)',
    platform: 'pc',
    clientVersion: '0.9.3',
    endpoints: ['/v1/auth/session', '/v1/profiles/me', '/v1/config/game'],
  },
];

interface TestResult {
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  cellIndex: string;
  requestId: string;
  success: boolean;
  error?: string;
}

class GatewayTestClient {
  private client: AxiosInstance;
  private results: TestResult[] = [];

  constructor(
    private baseUrl: string,
    private gameProfile: GameProfile,
  ) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Id': gameProfile.gameId,
        'X-Platform': gameProfile.platform,
        'X-Client-Version': gameProfile.clientVersion,
        'Authorization': `Bearer mock-jwt-token-${gameProfile.gameId}`,
      },
      validateStatus: () => true, // Don't throw on non-2xx
    });
  }

  async runSuite(): Promise<TestResult[]> {
    console.log(`\n🎮 Testing: ${this.gameProfile.name} (${this.gameProfile.platform})`);
    console.log(`   Endpoint: ${this.baseUrl}`);
    console.log(`   Client Version: ${this.gameProfile.clientVersion}`);
    console.log('   ---');

    // Health check
    await this.testEndpoint('GET', '/health');

    // Game-specific endpoints
    for (const endpoint of this.gameProfile.endpoints) {
      await this.testEndpoint('GET', endpoint);
      // Small delay between requests to simulate real client behavior
      await sleep(100);
    }

    // Test POST (e.g., telemetry)
    await this.testEndpoint('POST', '/v1/telemetry/events', {
      events: [
        { type: 'session_start', timestamp: Date.now() },
        { type: 'level_complete', timestamp: Date.now(), data: { level: 5 } },
      ],
    });

    // Test 404 handling
    await this.testEndpoint('GET', '/v1/nonexistent/endpoint');

    // Print summary
    this.printSummary();

    return this.results;
  }

  private async testEndpoint(method: string, path: string, body?: object): Promise<void> {
    const start = Date.now();
    let result: TestResult;

    try {
      const response: AxiosResponse = method === 'POST'
        ? await this.client.post(path, body)
        : await this.client.get(path);

      const latency = Date.now() - start;
      result = {
        endpoint: path,
        method,
        statusCode: response.status,
        latencyMs: latency,
        cellIndex: response.headers['x-cell-index'] || 'N/A',
        requestId: response.headers['x-request-id'] || 'N/A',
        success: response.status >= 200 && response.status < 500,
      };
    } catch (error) {
      const latency = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      result = {
        endpoint: path,
        method,
        statusCode: 0,
        latencyMs: latency,
        cellIndex: 'N/A',
        requestId: 'N/A',
        success: false,
        error: errorMsg,
      };
    }

    this.results.push(result);

    const statusIcon = result.success ? '✅' : '❌';
    const latencyColor = result.latencyMs < 100 ? '' : result.latencyMs < 500 ? '⚠️' : '🐢';
    console.log(
      `   ${statusIcon} ${method.padEnd(6)} ${path.padEnd(40)} ${result.statusCode} ${result.latencyMs}ms ${latencyColor} [Cell: ${result.cellIndex}]`,
    );
  }

  private printSummary(): void {
    const total = this.results.length;
    const successful = this.results.filter(r => r.success).length;
    const avgLatency = Math.round(this.results.reduce((sum, r) => sum + r.latencyMs, 0) / total);
    const p99Latency = this.results
      .map(r => r.latencyMs)
      .sort((a, b) => a - b)[Math.floor(total * 0.99)] || 0;

    console.log('\n   📊 Summary:');
    console.log(`      Success Rate: ${successful}/${total} (${Math.round(successful / total * 100)}%)`);
    console.log(`      Avg Latency:  ${avgLatency}ms`);
    console.log(`      P99 Latency:  ${p99Latency}ms`);
    console.log(`      Cells Hit:    ${[...new Set(this.results.map(r => r.cellIndex))].join(', ')}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI
program
  .name('gaming-gateway-test')
  .description('Test client for the Gaming Gateway Blueprint')
  .requiredOption('-e, --endpoint <url>', 'Gateway endpoint URL')
  .option('-g, --game <id>', 'Game profile ID (ac-valhalla, r6-siege, far-cry-6, the-division-2, legacy-game)')
  .option('-p, --platform <platform>', 'Override platform (pc, ps5, xbox, switch)')
  .option('-a, --all', 'Test all game profiles')
  .parse();

const opts = program.opts();

async function main() {
  console.log('🚀 Gaming Gateway Test Client');
  console.log('================================\n');

  const endpoint = opts.endpoint;
  let profiles: GameProfile[];

  if (opts.all) {
    profiles = GAME_PROFILES;
  } else if (opts.game) {
    const profile = GAME_PROFILES.find(p => p.gameId === opts.game);
    if (!profile) {
      console.error(`❌ Unknown game profile: ${opts.game}`);
      console.error(`   Available: ${GAME_PROFILES.map(p => p.gameId).join(', ')}`);
      process.exit(1);
    }
    if (opts.platform) {
      profile.platform = opts.platform;
    }
    profiles = [profile];
  } else {
    // Default: test first profile
    profiles = [GAME_PROFILES[0]];
  }

  const allResults: TestResult[] = [];

  for (const profile of profiles) {
    const client = new GatewayTestClient(endpoint, profile);
    const results = await client.runSuite();
    allResults.push(...results);
    await sleep(500);
  }

  // Final summary
  console.log('\n\n🏁 Final Results');
  console.log('================');
  const totalRequests = allResults.length;
  const totalSuccess = allResults.filter(r => r.success).length;
  const totalAvgLatency = Math.round(allResults.reduce((sum, r) => sum + r.latencyMs, 0) / totalRequests);
  console.log(`   Total Requests:  ${totalRequests}`);
  console.log(`   Success Rate:    ${totalSuccess}/${totalRequests} (${Math.round(totalSuccess / totalRequests * 100)}%)`);
  console.log(`   Avg Latency:     ${totalAvgLatency}ms`);
  console.log(`   Games Tested:    ${profiles.length}`);

  // Exit with error if any failures
  if (totalSuccess < totalRequests) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
