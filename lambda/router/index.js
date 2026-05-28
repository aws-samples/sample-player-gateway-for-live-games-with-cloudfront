"use strict";
/**
 * Gaming Gateway Router Function
 * Core routing logic for the serverless gaming gateway.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const ROUTES = [
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/health$/, backend: 'internal', timeout: 5000, retryable: false },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/auth\//, backend: 'auth-service', timeout: 10000, retryable: false },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/profiles\//, backend: 'profile-service', timeout: 15000, retryable: true },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/matchmaking\//, backend: 'matchmaking-service', timeout: 20000, retryable: true },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/leaderboards\//, backend: 'leaderboard-service', timeout: 10000, retryable: true },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/inventory\//, backend: 'inventory-service', timeout: 15000, retryable: true },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/social\//, backend: 'social-service', timeout: 10000, retryable: true },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/telemetry\//, backend: 'telemetry-service', timeout: 5000, retryable: false },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/config\//, backend: 'config-service', timeout: 5000, retryable: true },
  { pathPattern: /^(\/lambda|\/nginx|\/apigw)?\/v\d+\/store\//, backend: 'store-service', timeout: 15000, retryable: true },
];

const handler = async (event, context) => {
  const startTime = Date.now();
  const requestId = context.awsRequestId;
  // Support both ALB and API Gateway event formats
  const path = event.path || event.rawPath || event.requestContext?.http?.path || '/';
  const method = event.httpMethod || event.requestContext?.http?.method || 'GET';

  // Health check
  if (/^(\/lambda|\/nginx|\/apigw)?\/health$/.test(path)) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        'X-Cell-Index': process.env.CELL_INDEX || '0',
        'X-Backend-Type': 'lambda',
      },
      body: JSON.stringify({
        status: 'healthy',
        backend: 'lambda',
        cell: process.env.CELL_INDEX,
        timestamp: new Date().toISOString(),
        version: process.env.AWS_LAMBDA_FUNCTION_VERSION || 'unknown',
      }),
    };
  }

  // Extract client context (handle both ALB and APIGW header formats)
  const headers = event.headers || {};
  const clientContext = {
    gameId: headers['x-game-id'] || null,
    platform: headers['x-platform'] || null,
    clientVersion: headers['x-client-version'] || null,
    region: headers['cloudfront-viewer-country'] || null,
    sourceIp: (headers['x-forwarded-for'] || '').split(',')[0].trim() || event.requestContext?.http?.sourceIp || null,
  };

  // Route matching
  const route = ROUTES.find(r => r.pathPattern.test(path));

  if (!route) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId, 'X-Backend-Type': 'lambda' },
      body: JSON.stringify({ error: 'Route not found', code: 'ROUTE_NOT_FOUND', path, requestId }),
    };
  }

  const latency = Date.now() - startTime;
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Cell-Index': process.env.CELL_INDEX || '0',
      'X-Route-Backend': route.backend,
      'X-Gateway-Latency': latency.toString(),
      'X-Backend-Type': 'lambda',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Game-Id, X-Platform, X-Client-Version',
    },
    body: JSON.stringify({
      message: 'Request routed successfully',
      routing: { backend: route.backend, path, method, cell: process.env.CELL_INDEX, retryable: route.retryable },
      client: clientContext,
      metadata: { requestId, latencyMs: latency, timestamp: new Date().toISOString(), region: process.env.AWS_REGION },
    }),
  };
};
exports.handler = handler;
