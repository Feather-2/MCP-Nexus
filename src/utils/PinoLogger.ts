import pino from 'pino';
import type { Logger } from '../types/index.js';
import { getTraceId } from '../observability/trace.js';

export interface PinoLoggerOptions {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  pretty?: boolean;
}

function withTrace(meta: unknown): Record<string, unknown> | undefined {
  const traceId = getTraceId();
  if (!traceId && (meta == null || typeof meta !== 'object')) return undefined;

  const base: Record<string, unknown> = traceId ? { traceId } : {};
  if (meta == null) return Object.keys(base).length ? base : undefined;
  if (typeof meta === 'object' && !Array.isArray(meta)) return { ...base, ...(meta as any) };
  return { ...base, meta };
}

export class PinoLogger implements Logger {
  private readonly log: pino.Logger;

  constructor(options: PinoLoggerOptions = {}) {
    const level = options.level || (process.env.PB_LOG_LEVEL as any) || 'info';
    const pretty = options.pretty ?? (process.env.PB_LOG_PRETTY === '1');

    const transport = pretty
      ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } })
      : undefined;

    this.log = pino(
      {
        level,
        redact: {
          paths: [
            '*.password',
            '*.passwd',
            '*.pwd',
            '*.secret',
            '*.token',
            '*.apiKey',
            '*.apikey',
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.set-cookie',
            'headers.authorization',
            'headers.cookie',
            'headers.set-cookie'
          ],
          censor: '***'
        }
      },
      transport
    );
  }

  trace(message: string, meta?: any): void {
    this.log.trace(withTrace(meta), message);
  }

  debug(message: string, meta?: any): void {
    this.log.debug(withTrace(meta), message);
  }

  info(message: string, meta?: any): void {
    this.log.info(withTrace(meta), message);
  }

  warn(message: string, meta?: any): void {
    this.log.warn(withTrace(meta), message);
  }

  error(message: string, meta?: any): void {
    this.log.error(withTrace(meta), message);
  }
}

