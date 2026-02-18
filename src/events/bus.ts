import { LRUDeduper } from './deduper.js';
import { DEFAULT_EVENT_VERSION, EventBusEvents } from './types.js';
import type {
  Event,
  EventHandler,
  EventType,
  SubscriptionOptions,
  BackpressureDropPayload,
  BufferDropPayload,
  HandlerErrorPayload,
  HandlerTimeoutPayload
} from './types.js';

// 重新导出以便测试和外部使用
export { EventBusEvents } from './types.js';
export type {
  Event,
  EventHandler,
  EventType,
  SubscriptionOptions,
  BackpressureDropPayload,
  BufferDropPayload,
  HandlerErrorPayload,
  HandlerTimeoutPayload,
  LoggerErrorPayload
} from './types.js';

export interface EventBusOptions {
  queueDepth?: number; // 队列深度，默认 64
  bufferSize?: number; // 每订阅者缓冲，默认 16
  dedupLimit?: number; // 去重窗口大小，默认 256
}

export interface EventLoggerLike {
  log: (event: Event) => void | boolean | Promise<void | boolean>;
}

type SubscriptionEntry = {
  id: number;
  type: EventType;
  handler: EventHandler;
  timeoutMs: number;
  closed: boolean;
  closeSignal: Promise<void>;
  queue: Event[];
  running: boolean;
  bufferSize: number;
  close: () => void;
  enqueue: (evt: Event) => void;
};

function withTimeoutOrCancel(task: Promise<void>, timeoutMs: number, cancel: Promise<void>): Promise<void> {
  const guardedTask = task.catch(() => {});

  const races: Array<Promise<void>> = [guardedTask, cancel];

  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    races.push(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    );
  }

  return Promise.race(races).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const then = (value as { then?: unknown }).then;
  return typeof then === 'function';
}

function normalizeVersion(version: string | undefined): string {
  if (!version) return DEFAULT_EVENT_VERSION;
  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_EVENT_VERSION;
}

function createSubscriptionEntry(
  id: number,
  type: EventType,
  handler: EventHandler,
  options: SubscriptionOptions | undefined,
  bufferSize: number,
  onHandlerError: (subscriberId: number, evt: Event, error: Error) => void,
  onHandlerTimeout: (subscriberId: number, evt: Event, timeoutMs: number) => void
): SubscriptionEntry {
  const timeoutMs = Math.max(0, options?.timeout ?? 0);
  const queue: Event[] = [];
  let closeResolve!: () => void;
  const closeSignal = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  const entry: SubscriptionEntry = {
    id,
    type,
    handler,
    timeoutMs,
    closed: false,
    closeSignal,
    queue,
    running: false,
    bufferSize: Math.max(1, bufferSize),
    close: () => {
      if (entry.closed) return;
      entry.closed = true;
      entry.queue.length = 0;
      closeResolve();
    },
    enqueue: (evt: Event) => {
      if (entry.closed) return;
      if (entry.queue.length >= entry.bufferSize) return;
      entry.queue.push(evt);
      if (entry.running) return;
      entry.running = true;
      void (async () => {
        try {
          while (!entry.closed && entry.queue.length > 0) {
            const next = entry.queue.shift()!;
            let handlerError: Error | undefined;
            let timedOut = false;

            const task = Promise.resolve()
              .then(() => entry.handler(next))
              .then(() => {})
              .catch((err) => {
                handlerError = err instanceof Error ? err : new Error(String(err));
              });

            const timeoutPromise = timeoutMs > 0
              ? new Promise<void>((resolve) => {
                  setTimeout(() => {
                    timedOut = true;
                    resolve();
                  }, timeoutMs);
                })
              : Promise.race([]);

            await Promise.race([task, timeoutPromise, entry.closeSignal]);

            if (timedOut && !handlerError) {
              onHandlerTimeout(id, next, timeoutMs);
            } else if (handlerError) {
              onHandlerError(id, next, handlerError);
            }
          }
        } finally {
          entry.running = false;
        }
      })();
    }
  };

  return entry;
}

export interface EventBusStats {
  published: number;
  dropped: number;
  deduplicated: number;
  handlerErrors: number;
  handlerTimeouts: number;
  bufferDrops: number;
}

export class EventBus {
  private readonly queueDepth: number;
  private readonly bufferSize: number;
  private readonly deduper: LRUDeduper;

  private readonly queue: Event[] = [];
  private readonly subs = new Map<EventType, Map<number, SubscriptionEntry>>();

  private closed = false;
  private dispatchScheduled = false;
  private nextSubId = 1;
  private nextEventId = 1;
  private readonly logger?: EventLoggerLike;

  // 统计指标
  private stats: EventBusStats = {
    published: 0,
    dropped: 0,
    deduplicated: 0,
    handlerErrors: 0,
    handlerTimeouts: 0,
    bufferDrops: 0
  };

  constructor(options?: EventBusOptions, logger?: EventLoggerLike) {
    this.queueDepth = Math.max(1, options?.queueDepth ?? 64);
    this.bufferSize = Math.max(1, options?.bufferSize ?? 16);
    this.deduper = new LRUDeduper(Math.max(1, options?.dedupLimit ?? 256));
    this.logger = logger;
  }

  publish(event: Event): void {
    if (this.closed) return;
    if (!event?.type) throw new Error('events: missing type');

    const id = event.id && event.id.length > 0 ? event.id : `evt-${this.nextEventId++}`;
    const evt: Event = {
      ...event,
      id,
      version: normalizeVersion(event.version),
      timestamp: event.timestamp ?? new Date()
    };

    if (!this.deduper.allow(id)) {
      this.stats.deduplicated++;
      return;
    }
    if (this.queue.length >= this.queueDepth) {
      this.stats.dropped++;
      // 发射背压丢弃事件
      this.emitGovernanceEvent<BackpressureDropPayload>(EventBusEvents.BACKPRESSURE_DROP, {
        droppedEventId: id,
        droppedEventType: evt.type,
        queueDepth: this.queueDepth,
        reason: 'queue_full'
      });
      return;
    }

    this.stats.published++;
    this.queue.push(evt);
    if (this.logger) {
      try {
        const maybePromise = this.logger.log(evt);
        if (isPromiseLike(maybePromise)) {
          void maybePromise.catch(() => {});
        }
      } catch {
        // isolation: never let logger failures break publish
      }
    }
    this.ensureDispatchLoop();
  }

  subscribe(type: EventType, handler: EventHandler, options?: SubscriptionOptions): () => void {
    if (this.closed) return () => {};
    if (!type) throw new Error('events: missing type');

    const id = this.nextSubId++;
    const entry = createSubscriptionEntry(
      id,
      type,
      handler,
      options,
      this.bufferSize,
      (subscriberId, evt, error) => {
        this.stats.handlerErrors++;
        this.emitGovernanceEvent<HandlerErrorPayload>(EventBusEvents.HANDLER_ERROR, {
          subscriberId,
          eventId: evt.id || 'unknown',
          eventType: evt.type,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });
      },
      (subscriberId, evt, timeoutMs) => {
        this.stats.handlerTimeouts++;
        this.emitGovernanceEvent<HandlerTimeoutPayload>(EventBusEvents.HANDLER_TIMEOUT, {
          subscriberId,
          eventId: evt.id || 'unknown',
          eventType: evt.type,
          timeoutMs
        });
      }
    );

    let removed = false;
    const unsubscribe = () => {
      if (removed) return;
      removed = true;
      const bucket = this.subs.get(type);
      if (!bucket) return;
      const found = bucket.get(id);
      if (found) found.close();
      bucket.delete(id);
      if (bucket.size === 0) this.subs.delete(type);
    };

    let bucket = this.subs.get(type);
    if (!bucket) {
      bucket = new Map();
      this.subs.set(type, bucket);
    }
    bucket.set(id, entry);

    return unsubscribe;
  }

  getStats(): Readonly<EventBusStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      published: 0,
      dropped: 0,
      deduplicated: 0,
      handlerErrors: 0,
      handlerTimeouts: 0,
      bufferDrops: 0
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.queue.length = 0;
    this.dispatchScheduled = false;

    for (const bucket of this.subs.values()) {
      for (const sub of bucket.values()) sub.close();
    }
    this.subs.clear();
  }

  private ensureDispatchLoop(): void {
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    queueMicrotask(() => this.dispatchLoop());
  }

  private dispatchLoop(): void {
    if (this.closed) return;
    try {
      while (!this.closed && this.queue.length > 0) {
        const evt = this.queue.shift()!;
        this.dispatch(evt);
      }
    } finally {
      this.dispatchScheduled = false;
      if (!this.closed && this.queue.length > 0) this.ensureDispatchLoop();
    }
  }

  private dispatch(evt: Event): void {
    const bucket = this.subs.get(evt.type);
    if (!bucket || bucket.size === 0) return;

    const subscribers = [...bucket.values()];
    for (const sub of subscribers) {
      try {
        // 检查缓冲区是否已满
        if (!sub.closed && sub.queue.length >= sub.bufferSize) {
          this.stats.bufferDrops++;
          this.emitGovernanceEvent<BufferDropPayload>(EventBusEvents.BUFFER_DROP, {
            droppedEventId: evt.id || 'unknown',
            droppedEventType: evt.type,
            subscriberId: sub.id,
            bufferSize: sub.bufferSize,
            reason: 'buffer_full'
          });
        }
        sub.enqueue(evt);
      } catch (_e) {
        // isolation: never let one subscriber break dispatch
      }
    }
  }

  private emitGovernanceEvent<T>(type: string, payload: T): void {
    // 治理事件直接发射，不经过队列（避免递归）
    const evt: Event = {
      id: `evt-${this.nextEventId++}`,
      type,
      version: DEFAULT_EVENT_VERSION,
      timestamp: new Date(),
      component: 'EventBus',
      payload
    };

    if (this.logger) {
      try {
        const maybePromise = this.logger.log(evt);
        if (isPromiseLike(maybePromise)) {
          void maybePromise.catch(() => {});
        }
      } catch {
        // isolation: never let logger failures break governance events
      }
    }

    // 直接分发给订阅者（不入队）
    const bucket = this.subs.get(type);
    if (!bucket || bucket.size === 0) return;

    const subscribers = [...bucket.values()];
    for (const sub of subscribers) {
      if (!sub.closed && sub.queue.length < sub.bufferSize) {
        sub.queue.push(evt);
        if (!sub.running) {
          sub.running = true;
          void (async () => {
            try {
              while (!sub.closed && sub.queue.length > 0) {
                const next = sub.queue.shift()!;
                const task = Promise.resolve()
                  .then(() => sub.handler(next))
                  .then(() => {})
                  .catch(() => {});
                await withTimeoutOrCancel(task, sub.timeoutMs, sub.closeSignal);
              }
            } finally {
              sub.running = false;
            }
          })();
        }
      }
    }
  }
}
