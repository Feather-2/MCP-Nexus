import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { z } from 'zod';

/**
 * Log management and streaming routes
 */
export class LogRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get recent logs
    server.get('/api/logs', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const Q = z.object({ limit: z.coerce.number().int().positive().max(1000).optional().default(50) });
        const { limit } = Q.parse((request.query as any) || {});
        const recentLogs = this.ctx.logBuffer.slice(-limit);
        reply.send(recentLogs);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid query', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Failed to get logs', { code: 'LOG_ERROR' });
      }
    });

    // Server-Sent Events stream for real-time logs
    server.get('/api/logs/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Write SSE headers
        this.writeSseHeaders(reply, request);

        // Send initial connection message
        reply.raw.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message: '已连接到实时日志', service: 'monitor' })}\n\n`);

        // Add client to the set
        this.ctx.logStreamClients.add(reply);

        // Send recent logs
        for (const log of this.ctx.logBuffer.slice(-10)) {
          reply.raw.write(`data: ${JSON.stringify(log)}\n\n`);
        }

        // Handle client disconnect
        const cleanup = () => this.ctx.logStreamClients.delete(reply);
        request.socket.on('close', cleanup);
        request.socket.on('end', cleanup);
        request.socket.on('error', cleanup);
      } catch (error) {
        try { reply.raw.write(`data: ${JSON.stringify({ event: 'error', error: (error as Error).message })}\n\n`); } catch {}
        try { reply.raw.end(); } catch {}
      }
    });
  }

  private writeSseHeaders(reply: FastifyReply, request: FastifyRequest): void {
    const origin = request.headers['origin'] as string | undefined;
    const config = (this.ctx.configManager as any).config || {};
    const allowed = Array.isArray(config.corsOrigins) ? config.corsOrigins : [];
    const isAllowed = origin && allowed.includes(origin);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(isAllowed ? { 'Access-Control-Allow-Origin': origin!, 'Vary': 'Origin' } : {})
    });
  }
}
