import type { FastifyReply } from 'fastify';
import type { Disposable } from '../types/index.js';

/**
 * Manages Server-Sent Events (SSE) client connections.
 * Provides connection tracking, broadcasting, and cleanup.
 */

export class SseManager implements Disposable {
  private clients: Set<FastifyReply> = new Set();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly cleanupIntervalMs: number;
  private readonly maxConnections: number;

  constructor(cleanupIntervalMs: number = 30000, maxConnections: number = 200) {
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.maxConnections = maxConnections;
  }

  /**
   * Start periodic cleanup of disconnected clients.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.removeDisconnected();
    }, this.cleanupIntervalMs);
    (this.cleanupTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Add a client to the managed set.
   * Returns false if the connection limit has been reached.
   */
  add(client: FastifyReply): boolean {
    if (this.clients.size >= this.maxConnections) {
      return false;
    }
    this.clients.add(client);
    return true;
  }

  /**
   * Remove a client from the managed set.
   */
  remove(client: FastifyReply): void {
    this.clients.delete(client);
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(data: unknown): void {
    let message: string;
    try {
      message = `data: ${JSON.stringify(data)}\n\n`;
    } catch {
      return;
    }

    for (const client of Array.from(this.clients)) {
      try {
        client.raw.write(message);
      } catch {
        // Remove disconnected clients
        this.clients.delete(client);
      }
    }
  }

  /**
   * Send a message to a specific client.
   */
  send(client: FastifyReply, data: unknown): boolean {
    let message: string;
    try {
      message = `data: ${JSON.stringify(data)}\n\n`;
    } catch {
      return false;
    }
    try {
      client.raw.write(message);
      return true;
    } catch {
      this.clients.delete(client);
      return false;
    }
  }

  /**
   * Remove disconnected clients from the set.
   */
  removeDisconnected(): number {
    let removed = 0;
    for (const client of Array.from(this.clients)) {
      const raw = client.raw as { writableEnded?: boolean; destroyed?: boolean; write?: (chunk: string) => boolean };
      if (!raw || raw.writableEnded || raw.destroyed) {
        this.clients.delete(client);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get current client count.
   */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Get the underlying client set (for migration compatibility).
   */
  getClients(): Set<FastifyReply> {
    return this.clients;
  }

  /**
   * Close all connections and cleanup.
   */
  close(): void {
    this.stopCleanup();
    for (const client of this.clients) {
      try { client.raw.end(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }

  private disposed = false;
  dispose(): void { if (this.disposed) return; this.disposed = true; this.close(); }
}
