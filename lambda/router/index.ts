/**
 * Gaming Gateway Router Function
 *
 * Core routing logic for the serverless gaming gateway.
 * Handles:
 * - Path-based routing to backend services
 * - JWT passthrough (preserves existing auth)
 * - Client identification (game, platform, region)
 * - Request enrichment with gateway metadata
 * - Health check responses
 *
 * This function is invoked by the ALB and routes requests
 * to the appropriate backend service based on path patterns.
 */

import { ALBEvent, ALBResult, Context } from 'aws-lambda';

interface RouteConfig {
  pathPattern: RegExp;
  backend: string;
  timeout: number;
  retryable: boolean;
}

// Route configuration - externalize to DynamoDB or Parameter Store in production
const ROUTES: RouteConfig[] = [
  { pathPattern: /^\/health$/, backend: 'internal', timeout: 5000, retryable: false },
  { pathPattern: /^\/v\d+\/auth\//, backend: 'auth-service', timeout: 10000, retryable: false },
  { pathPattern: /^\/v\d+\/profiles\//, backend: 'profile-service', timeout: 15000, retryable: true },
  { pathPattern: /^\/v\d+\/matchmaking\//, backend: 'matchmaking-service', timeout: 20000, retryable: true },
  { pathPattern: /^\/v\d+\/leaderboards\//, backend: 'leaderboard-service', timeout: 10000, retryable: true },
  { pathPattern: /^\/v\d+\/inventory\//, backend: 'inventory-service', timeout: 15000, retryable: true },
  { pathPattern: /^\/v\d+\/social\//, backend: 'social-service', timeout: 10000, retryable: true },
  { pathPattern: /^\/v\d+\/telemetry\//, backend: 'telemetry-service', timeout: 5000, retryable: false },
  { pathPattern: /^\/v\d+\/config\//, backend: 'config-service', timeout: 5000, retryable: true },
  { pathPattern: /^\/v\d+\/store\//, backend: 'store-service', timeout: 15000, retryable: true },
];

export const handler = async (event: ALBEvent, context: Context): Promise<ALBResult> => {
  const startTime = Date.now();
  const requestId = context.awsRequestId;
  const path = event.path || '/';
  const method = event.httpMethod || 'GET';

  // Health check - fast path
  if (path === '/health') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        'X-Cell-Index': process.env.CELL_INDEX || '0',
      },
      body: JSON.stringify({
        status: 'healthy',
        cell: process.env.CELL_INDEX,
        timestamp: new Date().toISOString(),
        version: process.env.AWS_LAMBDA_FUNCTION_VERSION || 'unknown',
      }),
    };
  }

  // Extract client context from headers
  const clientContext = extractClientContext(event);

  // Route matching
  const route = ROUTES.find(r => r.pathPattern.test(path));

  if (!route) {
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({
        error: 'Route not found',
        code: 'ROUTE_NOT_FOUND',
        path,
        requestId,
      }),
    };
  }

  // TODO: Implement actual backend routing via HTTP client or Lambda invoke
  // For the blueprint, we return a mock response showing the routing decision
  const latency = Date.now() - startTime;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Cell-Index': process.env.CELL_INDEX || '0',
      'X-Route-Backend': route.backend,
      'X-Gateway-Latency': latency.toString(),
      // Preserve CORS headers for game clients
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Game-Id, X-Platform, X-Client-Version',
    },
    body: JSON.stringify({
      message: 'Request routed successfully',
      routing: {
        backend: route.backend,
        path,
        method,
        cell: process.env.CELL_INDEX,
        retryable: route.retryable,
      },
      client: clientContext,
      metadata: {
        requestId,
        latencyMs: latency,
        timestamp: new Date().toISOString(),
        region: process.env.AWS_REGION,
      },
    }),
  };
};

interface ClientContext {
  gameId: string | null;
  platform: string | null;
  clientVersion: string | null;
  region: string | null;
  sourceIp: string | null;
}

function extractClientContext(event: ALBEvent): ClientContext {
  const headers = event.headers || {};
  return {
    gameId: headers['x-game-id'] || null,
    platform: headers['x-platform'] || null,
    clientVersion: headers['x-client-version'] || null,
    region: headers['cloudfront-viewer-country'] || null,
    sourceIp: headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
  };
}
