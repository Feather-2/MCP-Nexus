import type { FastifyInstance, FastifyRequest } from 'fastify';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { GatewayConfig, Logger } from '../types/index.js';
import { createTraceId, enterTrace } from '../observability/trace.js';
import { parseAcceptLanguage, setLocale } from '../i18n/index.js';

type AugmentedRequest = FastifyRequest & Record<string, unknown>;
type OTelSpan = ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>;

const API_VERSION = 'v1';

export function setupObservabilityHooks(
  server: FastifyInstance,
  logger: Logger,
  _config: GatewayConfig
): void {
  // Trace id + API version headers
  server.addHook('onRequest', (request, _reply, done) => {
    const lang = request.headers['accept-language'];
    setLocale(parseAcceptLanguage(typeof lang === 'string' ? lang : undefined));
    done();
  });

  server.addHook('onRequest', (request, reply, done) => {
    const incoming = (request.headers['x-trace-id'] || request.headers['x-request-id']) as string | string[] | undefined;
    const clientTraceId = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : undefined;

    let span: OTelSpan | undefined;
    let otelTraceId: string | undefined;
    try {
      const tracer = trace.getTracer('pb-mcpgateway');
      span = tracer.startSpan(`HTTP ${request.method} ${request.url}`, {
        attributes: {
          'http.method': request.method,
          'http.target': request.url,
          'http.user_agent': String(request.headers['user-agent'] || ''),
          'net.peer.ip': request.ip
        }
      });
      const ctx = span?.spanContext?.();
      const tid = ctx?.traceId;
      if (typeof tid === 'string' && tid && !/^0+$/.test(tid)) {
        otelTraceId = tid;
      } else {
        try { span?.end?.(); } catch {}
        span = undefined;
      }
    } catch {
      span = undefined;
    }

    const traceId = otelTraceId || clientTraceId || createTraceId();
    (request as AugmentedRequest).traceId = traceId;
    (request as AugmentedRequest).startedAtMs = Date.now();
    if (span) {
      (request as AugmentedRequest).otelSpan = span;
      try {
        span.setAttribute?.('pb.trace_id', traceId);
        if (clientTraceId && clientTraceId !== traceId) {
          span.setAttribute?.('pb.client_trace_id', clientTraceId);
        }
      } catch {}
    }
    try { reply.header('X-Trace-Id', traceId); } catch {}
    enterTrace(traceId);
    done();
  });

  server.addHook('onSend', (request, reply, payload, done) => {
    try {
      if (!reply.raw?.headersSent) {
        reply.header('X-API-Version', API_VERSION);
        const traceId = (request as AugmentedRequest).traceId;
        if (traceId) reply.header('X-Trace-Id', traceId as string);
      }
    } catch {
      // ignore
    }
    done(null, payload);
  });

  server.addHook('onResponse', (request, reply, done) => {
    const startedAtMs = (request as AugmentedRequest).startedAtMs as number | undefined;
    const durationMs = typeof startedAtMs === 'number' ? Date.now() - startedAtMs : undefined;

    try {
      logger.info('http.request', {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs
      });
    } catch {
      // ignore
    }

    const span = (request as AugmentedRequest).otelSpan as OTelSpan | undefined;
    if (span) {
      try {
        span.setAttribute?.('http.status_code', reply.statusCode);
        if (typeof durationMs === 'number') {
          span.setAttribute?.('http.server_duration_ms', durationMs);
        }
        if (reply.statusCode >= 500) {
          span.setStatus?.({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus?.({ code: SpanStatusCode.OK });
        }
      } catch {}
      try { span.end?.(); } catch {}
    }

    done();
  });
}
