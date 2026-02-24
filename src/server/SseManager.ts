import type { FastifyReply } from 'fastify';
import type { Logger } from '../types/index.js';
import { unrefTimer } from '../utils/async.js';

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  service?: string;
  data?: unknown;
}

export interface SSEManagerOptions {
  maxLogBufferSize?: number;
  maxSseConnections?: number;
  enableDemoLogs?: boolean;
  cleanupIntervalMs?: number;
}

const NOOP_LOGGER: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * Unified SSE manager.
 *
 * Backward-compatible API:
 *  - new SseManager()
 *  - new SseManager(cleanupIntervalMs, maxConnections)
 *  - add/remove/broadcast/send/removeDisconnected/startCleanup/stopCleanup/close/getClients/size
 *
 * Server API:
 *  - new SseManager(logger, options)
 *  - initialize/stop + log/sandbox client sets + log buffer
 */
export class SseManager {
  private readonly logger: Logger;
  private readonly cleanupIntervalMs: number;
  private readonly maxLogBufferSize: number;
  private readonly maxSseConnections: number;
  private readonly enableDemoLogs: boolean;

  private readonly logBuffer: LogEntry[] = [];
  private readonly logStreamClients = new Set<FastifyReply>();
  private readonly sandboxStreamClients = new Set<FastifyReply>();

  private demoLogTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor();
  constructor(cleanupIntervalMs: number, maxConnections?: number);
  constructor(logger: Logger, options?: SSEManagerOptions);
  constructor(arg1?: Logger | number, arg2?: SSEManagerOptions | number) {
    if (typeof arg1 === 'number' || arg1 === undefined) {
      this.logger = NOOP_LOGGER;
      this.cleanupIntervalMs = arg1 ?? 30_000;
      this.maxSseConnections = typeof arg2 === 'number' ? arg2 : 200;
      this.maxLogBufferSize = 200;
      this.enableDemoLogs = false;
      return;
    }

    this.logger = arg1;
    const options = (typeof arg2 === 'object' && arg2) ? arg2 : {};
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 30_000;
    this.maxSseConnections = options.maxSseConnections ?? 200;
    this.maxLogBufferSize = options.maxLogBufferSize ?? 200;
    this.enableDemoLogs = options.enableDemoLogs ?? (process.env.NODE_ENV !== 'production');
  }

  get size(): number {
    return this.logStreamClients.size;
  }

  add(client: FastifyReply): boolean {
    if (this.size >= this.maxSseConnections) return false;
    this.logStreamClients.add(client);
    return true;
  }

  remove(client: FastifyReply): void {
    this.logStreamClients.delete(client);
  }

  getClients(): Set<FastifyReply> {
    return this.logStreamClients;
  }

  send(client: FastifyReply, payload: unknown): boolean {
    try {
      client.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      this.logStreamClients.delete(client);
      return false;
    }
  }

  broadcast(payload: unknown): void {
    for (const client of Array.from(this.logStreamClients)) {
      this.send(client, payload);
    }
  }

  removeDisconnected(): number {
    let removed = 0;

    for (const client of Array.from(this.logStreamClients)) {
      const raw = client.raw as { writableEnded?: boolean; destroyed?: boolean } | undefined;
      if (!raw || raw.writableEnded || raw.destroyed) {
        this.logStreamClients.delete(client);
        removed += 1;
      }
    }

    for (const client of Array.from(this.sandboxStreamClients)) {
      const raw = client.raw as { writableEnded?: boolean; destroyed?: boolean } | undefined;
      if (!raw || raw.writableEnded || raw.destroyed) {
        this.sandboxStreamClients.delete(client);
      }
    }

    return removed;
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.removeDisconnected();
    }, this.cleanupIntervalMs);
    unrefTimer(this.cleanupTimer);
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  close(): void {
    this.stopCleanup();
    this.logStreamClients.clear();
    this.sandboxStreamClients.clear();
  }

  initialize(): void {
    this.addLogEntry('info', '系统启动成功', 'gateway');
    this.addLogEntry('info', 'API 服务已就绪', 'api');
    this.addLogEntry('info', '监控服务已启动', 'monitor');

    if (this.enableDemoLogs) {
      this.demoLogTimer = setInterval(() => {
        const messages = [
          '处理客户端连接请求',
          '服务健康检查完成',
          '缓存清理任务执行',
          '网关路由更新',
          '认证令牌验证成功',
          '配置热重载完成'
        ];
        const levels = ['info', 'debug', 'warn'];
        const services = ['gateway', 'api', 'auth', 'router', 'monitor'];

        const message = messages[Math.floor(Math.random() * messages.length)];
        const level = levels[Math.floor(Math.random() * levels.length)];
        const service = services[Math.floor(Math.random() * services.length)];

        this.addLogEntry(level, message, service);
      }, 3000 + Math.random() * 7000);
      unrefTimer(this.demoLogTimer);
    }

    this.startCleanup();
  }

  stop(): void {
    if (this.demoLogTimer) {
      clearInterval(this.demoLogTimer);
      this.demoLogTimer = undefined;
    }
    this.stopCleanup();

    for (const client of this.logStreamClients) {
      try { client.raw.end(); } catch { /* best-effort */ }
    }
    for (const client of this.sandboxStreamClients) {
      try { client.raw.end(); } catch { /* best-effort */ }
    }
    this.logStreamClients.clear();
    this.sandboxStreamClients.clear();
  }

  addLogEntry(level: string, message: string, service?: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service,
      data
    };

    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogBufferSize) {
      this.logBuffer.shift();
    }

    const payload = { ...entry, serviceId: entry.service };
    this.broadcast(payload);
  }

  getLogBuffer(): LogEntry[] {
    return this.logBuffer;
  }

  getLogStreamClients(): Set<FastifyReply> {
    return this.logStreamClients;
  }

  getSandboxStreamClients(): Set<FastifyReply> {
    return this.sandboxStreamClients;
  }

  canAcceptSseClient(): boolean {
    return this.logStreamClients.size + this.sandboxStreamClients.size < this.maxSseConnections;
  }
}

export { SseManager as SSEManager };

