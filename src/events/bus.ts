import { LRUDeduper } from './deduper.js';
import type { Event, EventHandler, EventType, SubscriptionOptions } from './types.js';

export interface EventBusOptions {
  queueDepth?: number; // 队列深度，默认 64
  bufferSize?: number; // 每订阅者缓冲，默认 16
  dedupLimit?: number; // 去重窗口大小，默认 256
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

function createSubscriptionEntry(
  id: number,
  type: EventType,
  handler: EventHandler,
  options: SubscriptionOptions | undefined,
  bufferSize: number
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
            const task = Promise.resolve()
              .then(() => entry.handler(next))
              .then(() => {})
              .catch(() => {});
            await withTimeoutOrCancel(task, entry.timeoutMs, entry.closeSignal);
          }
        } finally {
          entry.running = false;
        }
      })();
    }
  };

  return entry;
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

  constructor(options?: EventBusOptions) {
    this.queueDepth = Math.max(1, options?.queueDepth ?? 64);
    this.bufferSize = Math.max(1, options?.bufferSize ?? 16);
    this.deduper = new LRUDeduper(Math.max(1, options?.dedupLimit ?? 256));
  }

  publish(event: Event): void {
    if (this.closed) return;
    if (!event?.type) throw new Error('events: missing type');

    const id = event.id && event.id.length > 0 ? event.id : `evt-${this.nextEventId++}`;
    const evt: Event = {
      ...event,
      id,
      timestamp: event.timestamp ?? new Date()
    };

    if (!this.deduper.allow(id)) return;
    if (this.queue.length >= this.queueDepth) return;

    this.queue.push(evt);
    this.ensureDispatchLoop();
  }

  subscribe(type: EventType, handler: EventHandler, options?: SubscriptionOptions): () => void {
    if (this.closed) return () => {};
    if (!type) throw new Error('events: missing type');

    const id = this.nextSubId++;
    const entry = createSubscriptionEntry(id, type, handler, options, this.bufferSize);

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
        sub.enqueue(evt);
      } catch {
        // isolation: never let one subscriber break dispatch
      }
    }
  }
}
