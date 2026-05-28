"use strict";
/**
 * Gateway Cell Handler
 * Each cell is an isolated processing unit with circuit breaker.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const circuitBreakers = new Map();
const FAILURE_THRESHOLD = 5;
const RECOVERY_TIMEOUT_MS = 30000;

const handler = async (event, context) => {
  const startTime = Date.now();
  const cellIndex = process.env.CELL_INDEX || '0';
  const requestId = context.awsRequestId;
  const path = event.path || '/';
  const method = event.httpMethod || 'GET';

  // Health check
  if (path === '/health' || path === '/lambda/health') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'X-Backend-Type': 'lambda' },
      body: JSON.stringify({
        status: 'healthy',
        backend: 'lambda',
        cell: cellIndex,
        uptime: process.uptime(),
      }),
    };
  }

  // Circuit breaker check
  const backendKey = resolveBackendKey(path);
  const circuit = getCircuitState(backendKey);

  if (circuit.state === 'open') {
    const timeSinceFailure = Date.now() - circuit.lastFailure;
    if (timeSinceFailure < RECOVERY_TIMEOUT_MS) {
      return {
        statusCode: 503,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': Math.ceil((RECOVERY_TIMEOUT_MS - timeSinceFailure) / 1000).toString(),
          'X-Cell-Index': cellIndex,
          'X-Request-Id': requestId,
          'X-Backend-Type': 'lambda',
        },
        body: JSON.stringify({
          error: 'Service temporarily unavailable',
          code: 'CIRCUIT_OPEN',
          retryAfterSeconds: Math.ceil((RECOVERY_TIMEOUT_MS - timeSinceFailure) / 1000),
          cell: cellIndex,
        }),
      };
    }
    circuit.state = 'half-open';
  }

  // Process request
  const latency = Date.now() - startTime;

  if (circuit.state === 'half-open') {
    circuit.state = 'closed';
    circuit.failures = 0;
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Cell-Index': cellIndex,
      'X-Request-Id': requestId,
      'X-Processing-Time': latency.toString(),
      'X-Backend-Type': 'lambda',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Game-Id, X-Platform',
    },
    body: JSON.stringify({
      message: 'Request processed by cell',
      backend: 'lambda',
      cell: cellIndex,
      path,
      method,
      timestamp: new Date().toISOString(),
      latencyMs: latency,
    }),
  };
};
exports.handler = handler;

function resolveBackendKey(path) {
  const segments = path.split('/').filter(Boolean);
  return segments.length >= 2 ? segments[1] : 'default';
}

function getCircuitState(key) {
  if (!circuitBreakers.has(key)) {
    circuitBreakers.set(key, { failures: 0, lastFailure: 0, state: 'closed' });
  }
  return circuitBreakers.get(key);
}
