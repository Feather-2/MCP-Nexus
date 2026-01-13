import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';

/**
 * Monitoring, health checks, and metrics routes
 */
export class MonitoringRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Redis rate-limit store connectivity check
    server.get('/api/health/ratelimit', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const rl = (this.ctx.configManager.getConfig() as any).rateLimiting || {};
        if (!rl.enabled) return reply.send({ enabled: false, store: 'memory' });
        if (rl.store !== 'redis') return reply.send({ enabled: true, store: 'memory' });

        const info: any = { enabled: true, store: 'redis', connected: false };
        try {
          const { default: IORedis } = await import('ioredis');
          let client;
          if (rl.redis?.url) {
            client = new (IORedis as any)(rl.redis.url);
          } else {
            client = new (IORedis as any)({
              host: rl.redis?.host || '127.0.0.1',
              port: rl.redis?.port || 6379,
              username: rl.redis?.username,
              password: rl.redis?.password,
              db: rl.redis?.db,
              tls: rl.redis?.tls ? {} : undefined
            });
          }
          const pong = await client.ping();
          info.connected = pong === 'PONG';
          await client.quit();
        } catch (e: any) {
          info.error = e?.message || String(e);
        }
        return reply.send(info);
      } catch (error) {
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Get comprehensive health status
    server.get('/api/health-status', async (request: FastifyRequest, reply: FastifyReply) => {
      const routerMetrics = this.ctx.router.getMetrics();
      const services = await this.ctx.serviceRegistry.listServices();

      const healthStatus = {
        gateway: {
          uptime: process.uptime() * 1000,
          status: 'healthy',
          version: '1.0.0'
        },
        metrics: {
          totalRequests: routerMetrics.totalRequests || 0,
          successRate: routerMetrics.successRate || 0,
          averageResponseTime: routerMetrics.averageResponseTime || 0,
          activeConnections: 0
        },
        services: {
          total: services.length,
          running: services.filter(s => s.state === 'running').length,
          stopped: services.filter(s => s.state === 'stopped').length,
          error: services.filter(s => s.state === 'error').length
        }
      };

      reply.send(healthStatus);
    });

    // Get registry statistics
    server.get('/api/metrics/registry', async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await this.ctx.serviceRegistry.getRegistryStats();
      reply.send({ stats });
    });

    // Aggregated health metrics
    server.get('/api/metrics/health', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const agg = await this.ctx.serviceRegistry.getHealthAggregates();
        reply.send(agg);
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Get router metrics
    server.get('/api/metrics/router', async (request: FastifyRequest, reply: FastifyReply) => {
      const metrics = this.ctx.router.getMetrics();
      reply.send({ metrics });
    });

    // Get service metrics
    server.get('/api/metrics/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const services = await this.ctx.serviceRegistry.listServices();
      const serviceMetrics = await Promise.all(
        services.map(async (service) => {
          try {
            const health = await this.ctx.serviceRegistry.checkHealth(service.id);
            return {
              serviceId: service.id,
              serviceName: service.config.name,
              health,
              uptime: Date.now() - service.startedAt.getTime()
            };
          } catch (error) {
            return {
              serviceId: service.id,
              serviceName: service.config.name,
              health: { status: 'unhealthy', error: error instanceof Error ? error.message : 'Unknown error' },
              uptime: 0
            };
          }
        })
      );

      reply.send({ serviceMetrics });
    });
  }
}
