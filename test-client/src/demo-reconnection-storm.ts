/**
 * Demo: Player Reconnection Storm Simulation
 *
 * Simulates the scenario where a game server outage causes 182K+ players
 * to reconnect simultaneously, creating a traffic spike that could be
 * mistaken for a DDoS attack.
 *
 * This demo shows how the WAF rules differentiate between:
 * - Legitimate player reconnection bursts (allowed through)
 * - Actual DDoS traffic without game client headers (blocked)
 *
 * Traffic distribution simulated:
 * - 35% Player traffic (with X-Game-Id header)
 * - 55% S2S + Admin traffic (with X-Traffic-Type header)
 * - 10% Unknown/malicious traffic (no identifying headers)
 *
 * Usage:
 *   npx ts-node src/demo-reconnection-storm.ts --endpoint https://<your-cloudfront-domain>
 *   npx ts-node src/demo-reconnection-storm.ts --endpoint <url> --phase all
 *   npx ts-node src/demo-reconnection-storm.ts --endpoint <url> --phase storm --peak-rps 500
 */

import axios, { AxiosInstance } from 'axios';
import { program } from 'commander';

interface PhaseMetrics {
  name: string;
  duration: number;
  totalRequests: number;
  allowed: number;
  blocked: number;
  errors: number;
  avgLatency: number;
  p99Latency: number;
  peakRps: number;
}

type TrafficType = 'player' | 's2s' | 'admin' | 'malicious';

const GAMES = ['ac-valhalla', 'r6-siege', 'far-cry-6', 'the-division-2', 'xdefiant'];
const PLATFORMS = ['pc', 'ps5', 'xbox', 'switch'];
const PLAYER_ENDPOINTS = ['/v1/auth/session', '/v1/profiles/me', '/v1/config/game', '/v1/matchmaking/queue'];
const S2S_ENDPOINTS = ['/v1/telemetry/events', '/v1/inventory/sync', '/v1/leaderboards/update'];
const ADMIN_ENDPOINTS = ['/v1/config/update', '/v1/admin/status', '/v1/admin/players'];

class ReconnectionStormDemo {
  private client: AxiosInstance;
  private phases: PhaseMetrics[] = [];

  constructor(private endpoint: string, private peakRps: number) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 10000,
      validateStatus: () => true,
    });
  }

  async runFullDemo(): Promise<void> {
    this.printBanner();

    // Phase 1: Normal traffic baseline
    console.log('\n\n📊 PHASE 1: Normal Traffic Baseline (15s)');
    console.log('   Simulating steady-state: 35% player, 55% S2S+admin, 10% other');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Baseline', 15, Math.floor(this.peakRps * 0.1), {
      player: 0.35,
      s2s: 0.40,
      admin: 0.15,
      malicious: 0.10,
    });

    // Phase 2: Server outage - traffic drops
    console.log('\n\n⚠️  PHASE 2: Server Outage - Traffic Drop (5s)');
    console.log('   Game servers go down. Players disconnect. S2S traffic spikes with errors.');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Outage', 5, Math.floor(this.peakRps * 0.05), {
      player: 0.05,
      s2s: 0.80,
      admin: 0.10,
      malicious: 0.05,
    });

    // Phase 3: RECONNECTION STORM - massive player spike
    console.log('\n\n🌊 PHASE 3: RECONNECTION STORM (20s)');
    console.log(`   182K+ players reconnect simultaneously. Peak: ${this.peakRps} RPS`);
    console.log('   Game clients send X-Game-Id header → WAF allows through');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Reconnection Storm', 20, this.peakRps, {
      player: 0.85, // 85% of traffic is players reconnecting
      s2s: 0.05,
      admin: 0.02,
      malicious: 0.08, // Opportunistic attackers during the chaos
    });

    // Phase 4: DDoS attempt during storm (no game headers)
    console.log('\n\n🚨 PHASE 4: DDoS Attack Mixed with Storm (15s)');
    console.log('   Attacker tries to exploit the reconnection event.');
    console.log('   Traffic WITHOUT X-Game-Id header → WAF BLOCKS');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('DDoS During Storm', 15, this.peakRps, {
      player: 0.40,
      s2s: 0.05,
      admin: 0.02,
      malicious: 0.53, // Majority is now attack traffic
    });

    // Phase 5: Recovery - traffic normalizes
    console.log('\n\n✅ PHASE 5: Recovery (10s)');
    console.log('   Players reconnected. Traffic returns to normal distribution.');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Recovery', 10, Math.floor(this.peakRps * 0.15), {
      player: 0.35,
      s2s: 0.45,
      admin: 0.10,
      malicious: 0.10,
    });

    // Phase 6: Rate-limit trigger — flood without game headers
    console.log('\n\n🚦 PHASE 6: RATE-LIMIT TRIGGER (40s)');
    console.log('   Sending 100% traffic WITHOUT X-Game-Id header to trigger NonPlayerRateLimit.');
    console.log('   WAF evaluates in ~30s windows. Expect blocks to start after ~30s.');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Rate-Limit Trigger', 40, Math.floor(this.peakRps * 0.5), {
      player: 0.0,
      s2s: 0.0,
      admin: 0.0,
      malicious: 1.0, // 100% non-game traffic to breach threshold
    });

    // Phase 7: Prove game clients still pass while IP is rate-limited
    console.log('\n\n🎮 PHASE 7: GAME CLIENTS BYPASS RATE-LIMIT (15s)');
    console.log('   Same IP is now rate-limited for non-game traffic.');
    console.log('   But requests WITH X-Game-Id header still pass → zero false positives.');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Game Client Bypass', 15, Math.floor(this.peakRps * 0.3), {
      player: 1.0, // 100% game client traffic — should all pass
      s2s: 0.0,
      admin: 0.0,
      malicious: 0.0,
    });

    // Final report
    this.printFinalReport();
  }

  async runStormOnly(): Promise<void> {
    this.printBanner();
    console.log('\n\n🌊 RECONNECTION STORM SIMULATION');
    console.log(`   Peak RPS: ${this.peakRps}`);
    console.log('   Duration: 30s');
    console.log('   ─────────────────────────────────────────────────────────────');
    await this.runPhase('Reconnection Storm', 30, this.peakRps, {
      player: 0.85,
      s2s: 0.05,
      admin: 0.02,
      malicious: 0.08,
    });
    this.printFinalReport();
  }

  private async runPhase(
    name: string,
    durationSec: number,
    targetRps: number,
    distribution: Record<TrafficType, number>,
  ): Promise<void> {
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;
    const intervalMs = 1000 / Math.max(targetRps, 1);

    let allowed = 0;
    let blocked = 0;
    let errors = 0;
    let totalRequests = 0;
    const latencies: number[] = [];
    let currentSecondRequests = 0;
    let lastSecond = Math.floor(startTime / 1000);
    let peakRps = 0;

    const activeRequests: Promise<void>[] = [];

    while (Date.now() < endTime) {
      // Track RPS
      const currentSec = Math.floor(Date.now() / 1000);
      if (currentSec !== lastSecond) {
        peakRps = Math.max(peakRps, currentSecondRequests);
        currentSecondRequests = 0;
        lastSecond = currentSec;
      }

      // Determine traffic type based on distribution
      const trafficType = this.pickTrafficType(distribution);
      const promise = this.sendTraffic(trafficType).then(result => {
        totalRequests++;
        currentSecondRequests++;
        latencies.push(result.latency);
        if (result.status === 'allowed') allowed++;
        else if (result.status === 'blocked') blocked++;
        else errors++;
      });

      activeRequests.push(promise);

      // Limit concurrency
      if (activeRequests.length > 200) {
        await Promise.race(activeRequests);
        activeRequests.length = 0;
      }

      await sleep(intervalMs);
    }

    await Promise.allSettled(activeRequests);

    const sorted = [...latencies].sort((a, b) => a - b);
    const metrics: PhaseMetrics = {
      name,
      duration: durationSec,
      totalRequests,
      allowed,
      blocked,
      errors,
      avgLatency: Math.round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
      p99Latency: sorted[Math.floor((sorted.length || 1) * 0.99)] || 0,
      peakRps,
    };
    this.phases.push(metrics);

    // Phase summary
    const blockRate = totalRequests > 0 ? (blocked / totalRequests * 100).toFixed(1) : '0';
    console.log(`\n   Results: ${totalRequests} requests | ✅ ${allowed} allowed | 🚫 ${blocked} blocked (${blockRate}%) | ❌ ${errors} errors`);
    console.log(`   Latency: avg ${metrics.avgLatency}ms | p99 ${metrics.p99Latency}ms | Peak: ${peakRps} RPS`);
  }

  private pickTrafficType(distribution: Record<TrafficType, number>): TrafficType {
    const rand = Math.random();
    let cumulative = 0;
    for (const [type, weight] of Object.entries(distribution)) {
      cumulative += weight;
      if (rand <= cumulative) return type as TrafficType;
    }
    return 'player';
  }

  private async sendTraffic(type: TrafficType): Promise<{ status: 'allowed' | 'blocked' | 'error'; latency: number }> {
    const start = Date.now();
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    };
    let path: string;

    switch (type) {
      case 'player':
        headers['X-Game-Id'] = GAMES[Math.floor(Math.random() * GAMES.length)];
        headers['X-Platform'] = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
        headers['X-Client-Version'] = '2.1.0';
        headers['Authorization'] = `Bearer player-token-${Math.random().toString(36).slice(2)}`;
        path = `/nginx${PLAYER_ENDPOINTS[Math.floor(Math.random() * PLAYER_ENDPOINTS.length)]}`;
        break;
      case 's2s':
        headers['X-Traffic-Type'] = 's2s';
        headers['X-Service-Name'] = 'game-server-cluster';
        headers['Authorization'] = 'Bearer s2s-service-token';
        path = `/nginx${S2S_ENDPOINTS[Math.floor(Math.random() * S2S_ENDPOINTS.length)]}`;
        break;
      case 'admin':
        headers['X-Traffic-Type'] = 'admin';
        headers['X-Operator-Id'] = 'ops-team';
        headers['Authorization'] = 'Bearer admin-token';
        path = `/nginx${ADMIN_ENDPOINTS[Math.floor(Math.random() * ADMIN_ENDPOINTS.length)]}`;
        break;
      case 'malicious':
        // No game headers - simulates DDoS or bot traffic
        path = `/nginx${PLAYER_ENDPOINTS[Math.floor(Math.random() * PLAYER_ENDPOINTS.length)]}`;
        break;
    }

    try {
      const response = await this.client.get(path, { headers });
      const latency = Date.now() - start;

      if (response.status === 403) {
        return { status: 'blocked', latency };
      } else if (response.status >= 200 && response.status < 500) {
        return { status: 'allowed', latency };
      } else {
        return { status: 'error', latency };
      }
    } catch {
      return { status: 'error', latency: Date.now() - start };
    }
  }

  private printBanner(): void {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════════╗');
    console.log('║  🎮 GATEWAY DEMO: Edge Security for NGINX/EC2 — DDoS Protection        ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                          ║');
    console.log('║  Scenario: CloudFront + WAF + Shield Advanced in front of NGINX/EC2      ║');
    console.log('║  Game server outage causes 182K+ players to reconnect simultaneously.    ║');
    console.log('║  WAF must distinguish this from a DDoS attack.                           ║');
    console.log('║                                                                          ║');
    console.log('║  Key differentiator: Game clients send X-Game-Id header                  ║');
    console.log('║  → Legitimate reconnections: ALLOWED (high rate limit)                   ║');
    console.log('║  → DDoS without headers: BLOCKED (strict rate limit)                     ║');
    console.log('║                                                                          ║');
    console.log('║  Backend: EC2 ASG running NGINX (current setup)                        ║');
    console.log('║  Edge: CloudFront + WAF + Shield Advanced + JA4 Fingerprinting           ║');
    console.log('║  Traffic split: 35% Player | 55% S2S+Admin | 10% Other                   ║');
    console.log('║                                                                          ║');
    console.log(`║  Endpoint: ${this.endpoint.padEnd(56)}║`);
    console.log(`║  Peak RPS: ${this.peakRps.toString().padEnd(56)}║`);
    console.log('║                                                                          ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  }

  private printFinalReport(): void {
    console.log('\n\n');
    console.log('╔══════════════════════════════════════════════════════════════════════════╗');
    console.log('║                        DEMO RESULTS SUMMARY                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                          ║');
    console.log('║  Phase                  │ Requests │ Allowed │ Blocked │ Avg Lat │ Peak  ║');
    console.log('║  ──────────────────────-┼──────────┼─────────┼─────────┼─────────┼───── ║');

    for (const phase of this.phases) {
      const name = phase.name.padEnd(23);
      const reqs = phase.totalRequests.toString().padEnd(8);
      const allowed = phase.allowed.toString().padEnd(7);
      const blocked = phase.blocked.toString().padEnd(7);
      const lat = `${phase.avgLatency}ms`.padEnd(7);
      const peak = `${phase.peakRps}`.padEnd(5);
      console.log(`║  ${name} │ ${reqs} │ ${allowed} │ ${blocked} │ ${lat} │ ${peak}║`);
    }

    console.log('║                                                                          ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                          ║');
    console.log('║  KEY TAKEAWAYS FOR UBISOFT:                                              ║');
    console.log('║                                                                          ║');
    console.log('║  1. Player reconnection storms (182K RPS) pass through WAF because       ║');
    console.log('║     game clients include X-Game-Id header → high rate limit applied      ║');
    console.log('║                                                                          ║');
    console.log('║  2. DDoS traffic WITHOUT game headers is blocked at strict rate limit    ║');
    console.log('║     (100 req/5min per IP) → triggers within ~30 seconds                  ║');
    console.log('║                                                                          ║');
    console.log('║  3. Rate-limited IPs can STILL send game client traffic (Phase 7)        ║');
    console.log('║     → X-Game-Id scopes the rule, eliminating false positives             ║');
    console.log('║                                                                          ║');
    console.log('║  4. Shield Advanced + Route53 health checks provide proactive            ║');
    console.log('║     engagement: DRT is notified when health degrades during spikes       ║');
    console.log('║                                                                          ║');
    console.log('║  5. Traffic visibility: S2S (55%) and Admin traffic tracked separately   ║');
    console.log('║     via WAF count rules for operational awareness                        ║');
    console.log('║                                                                          ║');
    console.log('║  📊 CloudWatch Dashboard: GamingGateway-Comparison-LambdaVsNginx         ║');
    console.log('║  🛡️  WAF Dashboard: Check WAF console for rule match metrics              ║');
    console.log('║                                                                          ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI
program
  .name('demo-reconnection-storm')
  .description('Demo: Player reconnection storm vs DDoS protection')
  .requiredOption('-e, --endpoint <url>', 'Gateway CloudFront endpoint URL')
  .option('-p, --peak-rps <number>', 'Peak requests per second during storm', '200')
  .option('--phase <phase>', 'Run specific phase: all, storm, ddos', 'all')
  .parse();

const opts = program.opts();

const demo = new ReconnectionStormDemo(opts.endpoint, parseInt(opts.peakRps));

if (opts.phase === 'storm') {
  demo.runStormOnly().catch(err => { console.error('Fatal:', err); process.exit(1); });
} else {
  demo.runFullDemo().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
