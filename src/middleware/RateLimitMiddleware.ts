import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../types/index.js';
import type { Context, Middleware, State } from './types.js';
import type { HttpErrorResponder } from './AuthMiddleware.js';

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
}

class MemoryFixedWindowStore {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  check(key: string, nowMs: number, maxRequests: number, windowMs: number): RateLimitDecision {
    const limit = Number.isFinite(maxRequests) && maxRequests > 0 ? Math.floor(maxRequests) : 0;
    const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;

    if (limit <= 0 || window <= 0) {
      return { allowed: true, limit, remaining: limit, resetAtMs: nowMs };
    }

    const existing = this.buckets.get(key);
    if (!existing || nowMs >= existing.resetAtMs) {
      const resetAtMs = nowMs + window;
      const count = 1;
      this.buckets.set(key, { count, resetAtMs });
      return { allowed: true, limit, remaining: Math.max(0, limit - count), resetAtMs };
    }

    const nextCount = existing.count + 1;
    existing.count = nextCount;
    this.buckets.set(key, existing);
    const remaining = Math.max(0, limit - nextCount);
    return { allowed: nextCount <= limit, limit, remaining, resetAtMs: existing.resetAtMs };
  }
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return undefined;
}

function extractApiKey(request: FastifyRequest): string | undefined {
  return (
    (request.headers['x-api-key'] as string) ||
    (request.headers['x-api-token'] as string) ||
    (request.headers['apikey'] as string) ||
    undefined
  );
}

function defaultRespondError(
  reply: FastifyReply,
  status: number,
  message: string,
  opts?: { code?: string; recoverable?: boolean; meta?: any }
): unknown {
  return reply.code(status).send({
    success: false,
    error: {
      message,
      code: opts?.code || 'INTERNAL_ERROR',
      recoverable: opts?.recoverable ?? false,
      meta: opts?.meta
    }
  });
}

export interface RateLimitMiddlewareOptions {
  requiresRateLimit?: (request: FastifyRequest) => boolean;
  respondError?: HttpErrorResponder;
  keyGenerator?: (request: FastifyRequest) => string;
  keyPrefix?: string;
}

type RedisLike = {
  incr: (key: string) => Promise<number>;
  pexpire: (key: string, ms: number) => Promise<number>;
  pttl: (key: string) => Promise<number>;
  quit: () => Promise<void>;
};

export class RateLimitMiddleware implements Middleware {
  readonly name = 'rate-limit';
  private readonly memory = new MemoryFixedWindowStore();
  private redisClient?: RedisLike;

  constructor(
    private readonly configProvider: { getConfig: () => GatewayConfig },
    private readonly options: RateLimitMiddlewareOptions = {}
  ) {}

  async beforeAgent(ctx: Context, state: State): Promise<void> {
    const http = ctx.http;
    if (!http) return;

    const cfg = this.configProvider.getConfig()?.rateLimiting as any;
    if (!cfg?.enabled) return;

    const { request, reply } = http;
    const requiresRateLimit = this.options.requiresRateLimit?.(request) ?? request.url.startsWith('/api/');
    if (!requiresRateLimit) return;

    const maxRequests = cfg.maxRequests ?? 100;
    const windowMs = cfg.windowMs ?? 60000;
    const store = (cfg.store ?? 'memory') as 'memory' | 'redis';
    const prefix = this.options.keyPrefix ?? 'rl:';

    const key =
      this.options.keyGenerator?.(request) ??
      (() => {
        const apiKey = extractApiKey(request) || extractBearerToken(request) || '';
        return apiKey ? `key:${apiKey.slice(0, 32)}` : `ip:${request.ip}`;
      })();
    const bucketKey = `${prefix}${key}`;

    const nowMs = Date.now();
    const decision =
      store === 'redis' ? await this.checkRedis(bucketKey, nowMs, maxRequests, windowMs, cfg.redis) : this.memory.check(bucketKey, nowMs, maxRequests, windowMs);

    try {
      reply.header('X-RateLimit-Limit', String(decision.limit));
      reply.header('X-RateLimit-Remaining', String(decision.remaining));
      reply.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAtMs / 1000)));
      if (!decision.allowed) {
        const retryAfterSeconds = Math.max(0, Math.ceil((decision.resetAtMs - nowMs) / 1000));
        reply.header('Retry-After', String(retryAfterSeconds));
      }
    } catch {
      // ignore header errors
    }

    if (decision.allowed) return;

    state.aborted = true;
    const responder = this.options.respondError ?? defaultRespondError;
    responder(reply, 429, 'Rate limit exceeded', {
      code: 'RATE_LIMITED',
      recoverable: true,
      meta: { limit: decision.limit, windowMs, resetAtMs: decision.resetAtMs }
    });
  }

  private async checkRedis(
    key: string,
    nowMs: number,
    maxRequests: number,
    windowMs: number,
    redisCfg: any
  ): Promise<RateLimitDecision> {
    const limit = Number.isFinite(maxRequests) && maxRequests > 0 ? Math.floor(maxRequests) : 0;
    const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
    if (limit <= 0 || window <= 0) {
      return { allowed: true, limit, remaining: limit, resetAtMs: nowMs };
    }

    const client = await this.getRedisClient(redisCfg);
    const count = await client.incr(key);
    if (count === 1) {
      await client.pexpire(key, window);
    }
    const ttlMs = await client.pttl(key);
    const resetAtMs = ttlMs > 0 ? nowMs + ttlMs : nowMs + window;
    const remaining = Math.max(0, limit - count);
    return { allowed: count <= limit, limit, remaining, resetAtMs };
  }

  private async getRedisClient(redisCfg: any): Promise<RedisLike> {
    if (this.redisClient) return this.redisClient;

    const { default: IORedis } = await import('ioredis');
    let client: any;
    if (redisCfg?.url) {
      client = new (IORedis as any)(redisCfg.url);
    } else {
      client = new (IORedis as any)({
        host: redisCfg?.host || '127.0.0.1',
        port: redisCfg?.port || 6379,
        username: redisCfg?.username,
        password: redisCfg?.password,
        db: redisCfg?.db,
        tls: redisCfg?.tls ? {} : undefined
      });
    }
    this.redisClient = client as RedisLike;
    return this.redisClient;
  }

  async shutdown(): Promise<void> {
    if (!this.redisClient) return;
    try {
      await this.redisClient.quit();
    } catch {
      // ignore
    }
    this.redisClient = undefined;
  }
}

