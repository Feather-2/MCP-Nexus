import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import type { Logger } from '../types/index.js';

let sdk: NodeSDK | undefined;
let starting: Promise<void> | undefined;
let enabled = false;

function parseHeaders(spec?: string): Record<string, string> | undefined {
  if (!spec || typeof spec !== 'string') return undefined;
  const out: Record<string, string> = {};
  for (const raw of spec.split(/[,;]/g)) {
    const part = raw.trim();
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeTracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (trimmed.endsWith('/v1/traces')) return trimmed;
  return `${trimmed}/v1/traces`;
}

function shouldEnable(): boolean {
  const disabled = (process.env.OTEL_SDK_DISABLED || '').toLowerCase() === 'true';
  if (disabled) return false;

  const pbEnabled = (process.env.PB_OTEL_ENABLED || '').toLowerCase();
  if (pbEnabled === '0' || pbEnabled === 'false') return false;
  if (pbEnabled === '1' || pbEnabled === 'true') return true;

  return Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

export function isOpenTelemetryEnabled(): boolean {
  return enabled;
}

export async function startOpenTelemetry(logger?: Logger, opts?: { serviceName?: string }): Promise<void> {
  if (sdk || starting) return starting ?? Promise.resolve();
  if (!shouldEnable()) return;

  starting = (async () => {
    try {
      const serviceName = opts?.serviceName || process.env.OTEL_SERVICE_NAME || 'pb-mcpgateway';
      const resource = resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName
      });

      const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const url = tracesEndpoint
        ? tracesEndpoint.trim()
        : (baseEndpoint ? normalizeTracesUrl(baseEndpoint) : undefined);

      const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS);
      const traceExporter = url
        ? new OTLPTraceExporter({ url, headers })
        : new OTLPTraceExporter({ headers });

      sdk = new NodeSDK({
        resource,
        traceExporter
      });

      await sdk.start();
      enabled = true;
      try { logger?.info?.('OpenTelemetry enabled', { serviceName, endpoint: url }); } catch {}
    } catch (error) {
      enabled = false;
      sdk = undefined;
      try { logger?.warn?.('Failed to start OpenTelemetry', { error: (error as any)?.message || String(error) }); } catch {}
    } finally {
      starting = undefined;
    }
  })();

  return starting;
}

export async function shutdownOpenTelemetry(logger?: Logger): Promise<void> {
  if (starting) {
    try { await starting; } catch {}
  }
  if (!sdk) return;
  const current = sdk;
  sdk = undefined;
  enabled = false;
  try {
    await current.shutdown();
  } catch (error) {
    try { logger?.warn?.('Failed to shutdown OpenTelemetry', { error: (error as any)?.message || String(error) }); } catch {}
  }
}
