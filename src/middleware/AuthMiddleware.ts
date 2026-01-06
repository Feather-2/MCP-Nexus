import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRequest, AuthResponse } from '../types/index.js';
import type { Context, Middleware, State } from './types.js';

export type HttpErrorResponder = (
  reply: FastifyReply,
  status: number,
  message: string,
  opts?: { code?: string; recoverable?: boolean; meta?: any }
) => unknown;

export interface AuthMiddlewareOptions {
  requiresAuth?: (request: FastifyRequest) => boolean;
  respondError?: HttpErrorResponder;
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

export class AuthMiddleware implements Middleware {
  readonly name = 'auth';

  constructor(
    private readonly authLayer: { authenticate: (request: AuthRequest) => Promise<AuthResponse> },
    private readonly options: AuthMiddlewareOptions = {}
  ) {}

  async beforeAgent(ctx: Context, state: State): Promise<void> {
    const http = ctx.http;
    if (!http) return;

    const { request, reply } = http;
    const requiresAuth = this.options.requiresAuth?.(request) ?? request.url.startsWith('/api/');
    if (request.url === '/health' || request.url === '/api/health' || !requiresAuth) return;

    const authRequest: AuthRequest = {
      token: extractBearerToken(request),
      apiKey: extractApiKey(request),
      clientIp: request.ip,
      method: request.method,
      resource: request.url
    };

    const authResponse = await this.authLayer.authenticate(authRequest);
    if (!authResponse.success) {
      state.aborted = true;
      const responder = this.options.respondError ?? defaultRespondError;
      responder(reply, 401, authResponse.error || 'Unauthorized', { code: 'UNAUTHORIZED', recoverable: true });
      return;
    }

    (request as any).auth = authResponse;
    const userId = authResponse.context?.userId;
    if (typeof userId === 'string' && userId.trim()) {
      ctx.sessionId = userId;
    }
  }
}

