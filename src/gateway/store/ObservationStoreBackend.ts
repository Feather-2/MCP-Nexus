/**
 * Abstract interface for observation store backend.
 * Supports both in-memory and distributed (Redis) implementations.
 */

export interface StoreEvent {
  type: 'set' | 'delete' | 'expire';
  key: string;
  value?: unknown;
  source?: string; // Instance ID that triggered the event
}

export type StoreEventHandler = (event: StoreEvent) => void;

export interface ObservationStoreBackend {
  /**
   * Get a value by key.
   */
  get<T>(key: string): Promise<T | undefined>;

  /**
   * Set a value with optional TTL.
   */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;

  /**
   * Delete a key.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if a key exists.
   */
  has(key: string): Promise<boolean>;

  /**
   * Get all keys matching a pattern.
   */
  keys(pattern?: string): Promise<string[]>;

  /**
   * Subscribe to store events.
   */
  subscribe(handler: StoreEventHandler): Promise<void>;

  /**
   * Unsubscribe from store events.
   */
  unsubscribe(handler: StoreEventHandler): Promise<void>;

  /**
   * Publish an event (for distributed backends).
   */
  publish(event: StoreEvent): Promise<void>;

  /**
   * Close connections and cleanup.
   */
  close(): Promise<void>;
}
