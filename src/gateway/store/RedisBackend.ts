/**
 * Redis implementation of ObservationStoreBackend.
 * Supports distributed state synchronization via Redis Pub/Sub.
 */

import type { ObservationStoreBackend, StoreEvent, StoreEventHandler } from './ObservationStoreBackend.js';

export interface RedisBackendOptions {
  /** Redis connection URL. */
  url: string;
  /** Key prefix for all operations. Default: 'pbmcp:' */
  keyPrefix?: string;
  /** Default TTL in milliseconds. Default: 86400000 (24 hours) */
  defaultTtlMs?: number;
  /** Instance ID for event source tracking. */
  instanceId?: string;
  /** Pub/Sub channel name. Default: 'pbmcp:events' */
  channelName?: string;
}

/**
 * Redis backend implementation.
 * NOTE: This is a reference implementation. In production, you would use
 * a Redis client library like 'ioredis' or 'redis'.
 */
export class RedisBackend implements ObservationStoreBackend {
  private readonly keyPrefix: string;
  private readonly defaultTtlMs: number;
  private readonly instanceId: string;
  private readonly channelName: string;
  private readonly handlers = new Set<StoreEventHandler>();

  // Placeholder for Redis client - in production use ioredis or redis package
  private client: any = null;
  private subscriber: any = null;
  private connected = false;

  constructor(private readonly options: RedisBackendOptions) {
    this.keyPrefix = options.keyPrefix ?? 'pbmcp:';
    this.defaultTtlMs = options.defaultTtlMs ?? 86400000;
    this.instanceId = options.instanceId ?? `instance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.channelName = options.channelName ?? 'pbmcp:events';
  }

  /**
   * Initialize Redis connections.
   * Call this before using the backend.
   */
  async connect(): Promise<void> {
    // In production, implement actual Redis connection:
    // this.client = new Redis(this.options.url);
    // this.subscriber = this.client.duplicate();
    // await this.subscriber.subscribe(this.channelName);
    // this.subscriber.on('message', (channel, message) => this.handleMessage(channel, message));

    this.connected = true;
    console.log(`[RedisBackend] Connected to ${this.options.url} (mock mode)`);
  }

  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.connected) {
      throw new Error('Redis backend not connected');
    }

    // In production:
    // const value = await this.client.get(this.prefixKey(key));
    // return value ? JSON.parse(value) : undefined;

    // Mock implementation - returns undefined
    return undefined;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    if (!this.connected) {
      throw new Error('Redis backend not connected');
    }

    const prefixedKey = this.prefixKey(key);
    const ttl = ttlMs ?? this.defaultTtlMs;

    // In production:
    // const serialized = JSON.stringify(value);
    // if (ttl > 0) {
    //   await this.client.setex(prefixedKey, Math.ceil(ttl / 1000), serialized);
    // } else {
    //   await this.client.set(prefixedKey, serialized);
    // }

    await this.publish({
      type: 'set',
      key,
      value,
      source: this.instanceId
    });
  }

  async delete(key: string): Promise<boolean> {
    if (!this.connected) {
      throw new Error('Redis backend not connected');
    }

    // In production:
    // const result = await this.client.del(this.prefixKey(key));
    // const existed = result > 0;

    const existed = false; // Mock

    await this.publish({
      type: 'delete',
      key,
      source: this.instanceId
    });

    return existed;
  }

  async has(key: string): Promise<boolean> {
    if (!this.connected) {
      throw new Error('Redis backend not connected');
    }

    // In production:
    // return (await this.client.exists(this.prefixKey(key))) === 1;

    return false; // Mock
  }

  async keys(pattern?: string): Promise<string[]> {
    if (!this.connected) {
      throw new Error('Redis backend not connected');
    }

    // In production:
    // const redisPattern = this.prefixKey(pattern ?? '*');
    // const keys = await this.client.keys(redisPattern);
    // return keys.map(k => k.slice(this.keyPrefix.length));

    return []; // Mock
  }

  async subscribe(handler: StoreEventHandler): Promise<void> {
    this.handlers.add(handler);
  }

  async unsubscribe(handler: StoreEventHandler): Promise<void> {
    this.handlers.delete(handler);
  }

  async publish(event: StoreEvent): Promise<void> {
    if (!this.connected) {
      throw new Error('Redis backend not connected');
    }

    // In production:
    // const message = JSON.stringify(event);
    // await this.client.publish(this.channelName, message);

    // Notify local handlers
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  async close(): Promise<void> {
    // In production:
    // await this.subscriber?.unsubscribe(this.channelName);
    // await this.subscriber?.quit();
    // await this.client?.quit();

    this.handlers.clear();
    this.connected = false;
  }

  /**
   * Handle incoming Pub/Sub messages.
   */
  private handleMessage(channel: string, message: string): void {
    if (channel !== this.channelName) return;

    try {
      const event = JSON.parse(message) as StoreEvent;

      // Skip events from this instance
      if (event.source === this.instanceId) return;

      for (const handler of this.handlers) {
        try {
          handler(event);
        } catch {
          // Ignore handler errors
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Get connection status.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get instance ID.
   */
  getInstanceId(): string {
    return this.instanceId;
  }
}
