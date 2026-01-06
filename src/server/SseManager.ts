import type { FastifyReply } from 'fastify';

/**
 * Manages Server-Sent Events (SSE) client connections.
 * Provides connection tracking, broadcasting, and cleanup.
 */

export class SseManager {
  private clients: Set<FastifyReply> = new Set();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly cleanupIntervalMs: number;

  constructor(cleanupIntervalMs: number = 30000) {
    this.cleanupIntervalMs = cleanupIntervalMs;
  }

  /**
   * Start periodic cleanup of disconnected clients.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.removeDisconnected();
    }, this.cleanupIntervalMs);
    (this.cleanupTimer as any).unref?.();
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
   */
  add(client: FastifyReply): void {
    this.clients.add(client);
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
  broadcast(data: any): void {
    const message = `data: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
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
  send(client: FastifyReply, data: any): boolean {
    const message = `data: ${JSON.stringify(data)}\n\n`;
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
      const raw: any = client.raw as any;
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
    this.clients.clear();
  }
}
