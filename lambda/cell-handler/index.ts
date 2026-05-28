/**
 * Gateway Cell Handler
 *
 * Each cell is an isolated processing unit that handles a subset of traffic.
 * Cells provide blast radius isolation - if one cell has issues, others continue serving.
 *
 * Responsibilities:
 * - Receive requests from ALB
 * - Apply cell-specific rate limiting
 * - Forward to router function for backend resolution
 * - Emit cell-level metrics
 * - Handle circuit breaking for downstream failures
 */

import { ALBEvent, ALBResult, Context } from 'aws-lambda';

// Circuit breaker state (in-memory per Lambda instance)
interface CircuitState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

const circuitBreakers: Map<string, CircuitState> = new Map();
const FAILURE_THRESHOLD = 5;
const RECOVERY_TIMEOUT_MS = 30000; // 30 seconds

export const handler = async (event: ALBEvent, context: Context): Promise<ALBResult> => {
  const startTime = Date.now();
  const cellIndex = process.env.CELL_INDEX || '0';
  const requestId = context.awsRequestId;
  const path = event.path || '/';

  // Health check - immediate response
  if (path === '/health') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'healthy',
        cell: cellIndex,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
      }),
    };
  }

  // Check circuit breaker for the target backend
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
        },
        body: JSON.stringify({
          error: 'Service temporarily unavailable',
          code: 'CIRCUIT_OPEN',
          retryAfterSeconds: Math.ceil((RECOVERY_TIMEOUT_MS - timeSinceFailure) / 1000),
          cell: cellIndex,
        }),
      };
    }
    // Transition to half-open
    circuit.state = 'half-open';
  }

  try {
    // Process the request (in production, this invokes the router function)
    const response = await processRequest(event, context);

    // Reset circuit breaker on success
    if (circuit.state === 'half-open') {
      circuit.state = 'closed';
      circuit.failures = 0;
    }

    const latency = Date.now() - startTime;

    // Add gateway headers
    response.headers = {
      ...response.headers,
      'X-Cell-Index': cellIndex,
      'X-Request-Id': requestId,
      'X-Processing-Time': latency.toString(),
    };

    return response;
  } catch (error) {
    // Record failure for circuit breaker
    circuit.failures++;
    circuit.lastFailure = Date.now();
    if (circuit.failures >= FAILURE_THRESHOLD) {
      circuit.state = 'open';
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Cell ${cellIndex}] Error processing request:`, {
      path,
      error: errorMessage,
      circuitState: circuit.state,
      failures: circuit.failures,
    });

    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'X-Cell-Index': cellIndex,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({
        error: 'Bad Gateway',
        code: 'BACKEND_ERROR',
        cell: cellIndex,
        requestId,
      }),
    };
  }
};

async function processRequest(event: ALBEvent, context: Context): Promise<ALBResult> {
  // In production, this would:
  // 1. Check rate limits against Redis
  // 2. Invoke the router function or directly call backend
  // 3. Apply response transformations

  const path = event.path || '/';
  const method = event.httpMethod || 'GET';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Game-Id, X-Platform',
    },
    body: JSON.stringify({
      message: 'Request processed by cell',
      cell: process.env.CELL_INDEX,
      path,
      method,
      timestamp: new Date().toISOString(),
    }),
  };
}

function resolveBackendKey(path: string): string {
  const segments = path.split('/').filter(Boolean);
  // Use the service segment as the circuit breaker key
  // e.g., /v1/auth/login -> "auth"
  return segments.length >= 2 ? segments[1] : 'default';
}

function getCircuitState(key: string): CircuitState {
  if (!circuitBreakers.has(key)) {
    circuitBreakers.set(key, { failures: 0, lastFailure: 0, state: 'closed' });
  }
  return circuitBreakers.get(key)!;
}
