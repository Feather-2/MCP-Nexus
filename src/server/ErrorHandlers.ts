import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from '../types/index.js';

type AugmentedRequest = FastifyRequest & Record<string, unknown>;

export function registerErrorHandlers(server: FastifyInstance, logger: Logger): void {
  server.setErrorHandler(async (error, request, reply) => {
    try {
      const span = (request as AugmentedRequest).otelSpan as ReturnType<ReturnType<typeof trace.getTracer>['startSpan']> | undefined;
      if (span) {
        span.recordException?.(error instanceof Error ? error : new Error(String(error)));
        span.setStatus?.({ code: SpanStatusCode.ERROR, message: (error as Error)?.message || String(error) });
      }
    } catch { /* best-effort OTel span annotation */ }

    const errorDetails = {
      method: request.method,
      url: request.url,
      message: (error as Error)?.message || String(error),
      stack: (error as Error)?.stack,
      code: (error as Record<string, unknown>)?.code,
      statusCode: (error as Record<string, unknown>)?.statusCode
    };
    logger.error('HTTP API error:', errorDetails);

    const safeMessage = process.env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : (error as Error)?.message;
    reply.code(500).send({
      success: false,
      error: {
        message: safeMessage || 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        recoverable: false
      }
    });
  });

  server.setNotFoundHandler(async (request, reply) => {
    reply.code(404).send({
      success: false,
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        code: 'NOT_FOUND',
        recoverable: false
      }
    });
  });
}

