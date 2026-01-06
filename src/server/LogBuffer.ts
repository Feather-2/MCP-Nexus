/**
 * Circular log buffer with configurable size limit.
 * Provides log storage and retrieval for the gateway dashboard.
 */

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  service?: string;
  data?: any;
}

export class LogBuffer {
  private readonly maxSize: number;
  private buffer: LogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();

  constructor(maxSize: number = 200) {
    this.maxSize = maxSize;
  }

  /**
   * Add a log entry to the buffer.
   * Removes oldest entry if buffer exceeds max size.
   */
  add(level: string, message: string, service?: string, data?: any): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service,
      data
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors
      }
    }

    return entry;
  }

  /**
   * Get all entries in the buffer.
   */
  getAll(): LogEntry[] {
    return [...this.buffer];
  }

  /**
   * Get entries filtered by level.
   */
  getByLevel(level: string): LogEntry[] {
    return this.buffer.filter(e => e.level === level);
  }

  /**
   * Get entries filtered by service.
   */
  getByService(service: string): LogEntry[] {
    return this.buffer.filter(e => e.service === service);
  }

  /**
   * Get the most recent N entries.
   */
  getRecent(count: number): LogEntry[] {
    return this.buffer.slice(-count);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get current buffer size.
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Subscribe to new log entries.
   */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
