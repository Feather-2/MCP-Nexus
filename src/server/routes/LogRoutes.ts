import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';

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
      const { limit } = request.query as { limit?: string };
      const logLimit = limit ? parseInt(limit) : 50;

      const recentLogs = this.ctx.logBuffer.slice(-logLimit);
      reply.send(recentLogs);
    });

    // Server-Sent Events stream for real-time logs
    server.get('/api/logs/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      // Write SSE headers
      this.writeSseHeaders(reply, request);

      // Send initial connection message
      reply.raw.write(`data: ${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: '已连接到实时日志',
        service: 'monitor'
      })}\n\n`);

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
