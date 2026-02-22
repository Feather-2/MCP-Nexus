import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { GatewayConfig, Logger } from '../types/index.js';
import type { Context, State } from '../middleware/types.js';
import type { MiddlewareChain } from '../middleware/chain.js';

type AugmentedRequest = FastifyRequest & Record<string, unknown>;
type AugmentedReply = FastifyReply & { sent?: boolean; elapsedTime?: number };

type MiddlewareErrorPayload = {
  status: number;
  code: string;
  message: string;
  recoverable: boolean;
  meta?: unknown;
};

type RespondError = (
  reply: FastifyReply,
  status: number,
  message: string,
  opts?: { code?: string; recoverable?: boolean; meta?: unknown }
) => unknown;

type MapMiddlewareError = (error: unknown) => MiddlewareErrorPayload;

export function setupMiddlewareWiring(
  server: FastifyInstance,
  config: GatewayConfig,
  logger: Logger,
  middlewareChain: MiddlewareChain,
  respondError: RespondError,
  mapMiddlewareError: MapMiddlewareError
): void {
  // Business logic middleware chain bridge (auth / rate-limit live in chain).
  server.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const controller = new AbortController();
    try {
      let aborted = false;
      const doAbort = (reason: string) => {
        if (aborted) return;
        aborted = true;
        controller.abort(new Error(reason));
      };
      request.raw.once('aborted', () => doAbort('client aborted'));
      request.raw.once('close', () => doAbort('client closed'));
    } catch {
      // ignore
    }

    const traceId = (request as AugmentedRequest).traceId as string | undefined;
    const startedAtMs2 = (request as AugmentedRequest).startedAtMs as number | undefined;
    const mwCtx: Context = {
      requestId: traceId || `http-${Date.now()}`,
      traceId,
      startTime: typeof startedAtMs2 === 'number' ? startedAtMs2 : Date.now(),
      metadata: {
        method: request.method,
        url: request.url,
        ip: request.ip
      },
      http: { request, reply },
      signal: controller.signal
    };
    const mwState: State = {
      stage: 'beforeAgent',
      values: new Map<string, unknown>(),
      aborted: false
    };

    (request as AugmentedRequest).__mwCtx = mwCtx;
    (request as AugmentedRequest).__mwState = mwState;

    try {
      await middlewareChain.execute('beforeAgent', mwCtx, mwState);
    } catch (error) {
      if ((reply as AugmentedReply).sent || reply.raw?.headersSent) return;
      const mapped = mapMiddlewareError(error);
      return respondError(reply, mapped.status, mapped.message, {
        code: mapped.code,
        recoverable: mapped.recoverable,
        meta: mapped.meta
      });
    }

    if (mwState.aborted) {
      if ((reply as AugmentedReply).sent || reply.raw?.headersSent) return;
      const mapped = mapMiddlewareError(mwState.error || new Error('Request aborted'));
      return respondError(reply, mapped.status, mapped.message, {
        code: mapped.code,
        recoverable: mapped.recoverable,
        meta: mapped.meta
      });
    }
  });

  // Security headers via helmet (production-ready defaults)
  server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.host === '127.0.0.1' || config.host === 'localhost' ? false : { maxAge: 31536000 }
  } as Parameters<typeof helmet>[1]);

  // CORS middleware
  server.register(cors, {
    origin: (origin, cb) => {
      try {
        // Always allow requests without origin (same-origin, non-browser, curl, etc.)
        if (!origin) return cb(null, true);

        // If CORS is disabled, only allow same-origin
        if (!config.enableCors) {
          const selfOrigin = `http://${config.host || '127.0.0.1'}:${config.port || 19233}`;
          const isSameOrigin = origin === selfOrigin ||
                               origin === selfOrigin.replace('127.0.0.1', 'localhost') ||
                               origin === selfOrigin.replace('localhost', '127.0.0.1');
          return cb(null, isSameOrigin);
        }

        // Check if origin is the server itself
        const selfOrigin = `http://${config.host || '127.0.0.1'}:${config.port || 19233}`;
        if (origin === selfOrigin ||
            origin === selfOrigin.replace('127.0.0.1', 'localhost') ||
            origin === selfOrigin.replace('localhost', '127.0.0.1')) {
          return cb(null, true);
        }

        // Check configured origins
        const allowed = new Set(config.corsOrigins || []);
        if (allowed.has(origin)) return cb(null, true);

        // Allow subpath variants without trailing slash issues
        const o = origin.replace(/\/$/, '');
        for (const a of allowed) {
          if (o === a.replace(/\/$/, '')) return cb(null, true);
        }

        return cb(new Error('CORS origin not allowed'), false);
      } catch (e) {
        return cb(e as Error, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
  });
  // No extra auth / rate-limit hooks here (handled by middleware chain).

  // Request logging
  server.addHook('onRequest', async (request: FastifyRequest) => {
    logger.debug(`${request.method} ${request.url}`, {
      ip: request.ip,
      userAgent: request.headers['user-agent']
    });
  });

  // Response logging (helmet handles security headers)
  server.addHook('onSend', (request: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
    try {
      const elapsed = (reply as AugmentedReply).elapsedTime ?? undefined;
      logger.debug(`${request.method} ${request.url} - ${reply.statusCode}`, { responseTime: elapsed });
    } catch {
      // ignore
    }
    done(null, payload);
  });

  // Post-response stage for middleware chain (best-effort).
  server.addHook('onResponse', async (request: FastifyRequest) => {
    try {
      const mwCtx = (request as AugmentedRequest).__mwCtx;
      const mwState = (request as AugmentedRequest).__mwState;
      if (!mwCtx || !mwState) return;
      await middlewareChain.execute('afterAgent', mwCtx as Context, mwState as State);
    } catch {
      // ignore
    }
  });
}
