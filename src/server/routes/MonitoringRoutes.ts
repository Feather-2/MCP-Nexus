import { FastifyRequest, FastifyReply } from 'fastify';
import { Counter, Gauge, Registry } from 'prom-client';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { AlertManager } from '../../observability/AlertManager.js';
import { PrometheusExporter } from '../../observability/PrometheusExporter.js';

type RouterMetricsSnapshot = ReturnType<RouteContext['router']['getMetrics']>;
type RegistryStatsSnapshot = Awaited<ReturnType<RouteContext['serviceRegistry']['getRegistryStats']>>;

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

/**
 * Monitoring, health checks, and metrics routes
 */
export class MonitoringRoutes extends BaseRouteHandler {
  private readonly metricsRegistry: Registry;
  private readonly gatewayUptimeGauge: Gauge;
  private readonly gatewayRequestsCounter: Counter;
  private readonly gatewaySuccessRateGauge: Gauge;
  private readonly gatewayResponseTimeGauge: Gauge;
  private readonly gatewayServicesTotalGauge: Gauge;
  private readonly gatewayServicesRunningGauge: Gauge;
  private readonly gatewayServicesStoppedGauge: Gauge;
  private readonly gatewayServicesErrorGauge: Gauge;
  private lastObservedTotalRequests = 0;
  private readonly alertManager: AlertManager;
  private readonly prometheusExporter: PrometheusExporter;

  constructor(ctx: RouteContext) {
    super(ctx);
    this.alertManager = new AlertManager(ctx.logger);
    this.prometheusExporter = new PrometheusExporter();
    this.prometheusExporter.attachToEventBus(ctx.eventBus);
    this.metricsRegistry = new Registry();
    this.gatewayUptimeGauge = new Gauge({
      name: 'gateway_uptime_ms',
      help: 'Gateway uptime in milliseconds',
      registers: [this.metricsRegistry]
    });
    this.gatewayRequestsCounter = new Counter({
      name: 'gateway_requests_total',
      help: 'Total number of requests handled by gateway router',
      registers: [this.metricsRegistry]
    });
    this.gatewaySuccessRateGauge = new Gauge({
      name: 'gateway_success_rate',
      help: 'Gateway request success rate',
      registers: [this.metricsRegistry]
    });
    this.gatewayResponseTimeGauge = new Gauge({
      name: 'gateway_response_time_ms',
      help: 'Gateway average response time in milliseconds',
      registers: [this.metricsRegistry]
    });
    this.gatewayServicesTotalGauge = new Gauge({
      name: 'gateway_services_total',
      help: 'Total number of service instances',
      registers: [this.metricsRegistry]
    });
    this.gatewayServicesRunningGauge = new Gauge({
      name: 'gateway_services_running',
      help: 'Number of running service instances',
      registers: [this.metricsRegistry]
    });
    this.gatewayServicesStoppedGauge = new Gauge({
      name: 'gateway_services_stopped',
      help: 'Number of stopped service instances',
      registers: [this.metricsRegistry]
    });
    this.gatewayServicesErrorGauge = new Gauge({
      name: 'gateway_services_error',
      help: 'Number of service instances in error state',
      registers: [this.metricsRegistry]
    });
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Prometheus-compatible metrics endpoint
    server.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const routerMetrics = this.ctx.router.getMetrics();
        const registryStats = await this.ctx.serviceRegistry.getRegistryStats();
        this.updatePrometheusMetrics(routerMetrics, registryStats);

        const gatewayMetrics = await this.metricsRegistry.metrics();
        const observabilityMetrics = await this.prometheusExporter.getMetrics();
        const combinedMetrics = gatewayMetrics + '\n' + observabilityMetrics;

        reply.header('Content-Type', PROMETHEUS_CONTENT_TYPE);
        return reply.send(combinedMetrics);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to collect metrics';
        this.ctx.logger.error('Failed to collect Prometheus metrics', { message });
        return reply.code(500).send({ error: message });
      }
    });

    // Redis rate-limit store connectivity check
    server.get('/api/health/ratelimit', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const cfg = this.ctx.configManager.getConfig() as Record<string, unknown>;
        const rl = (cfg.rateLimiting || {}) as Record<string, unknown>;
        if (!rl.enabled) return reply.send({ enabled: false, store: 'memory' });
        if (rl.store !== 'redis') return reply.send({ enabled: true, store: 'memory' });

        const info: Record<string, unknown> = { enabled: true, store: 'redis', connected: false };
        try {
          const { default: IORedis } = await import('ioredis');
          const redisCfg = (rl.redis || {}) as Record<string, unknown>;
          let client: { ping: () => Promise<string>; quit: () => Promise<unknown> };
          if (redisCfg.url) {
            client = new (IORedis as unknown as new (url: string) => typeof client)(redisCfg.url as string);
          } else {
            client = new (IORedis as unknown as new (opts: Record<string, unknown>) => typeof client)({
              host: (redisCfg.host as string) || '127.0.0.1',
              port: (redisCfg.port as number) || 6379,
              username: redisCfg.username as string | undefined,
              password: redisCfg.password as string | undefined,
              db: redisCfg.db as number | undefined,
              tls: redisCfg.tls ? {} : undefined
            });
          }
          const pong = await client.ping();
          info.connected = pong === 'PONG';
          await client.quit();
        } catch (e: unknown) {
          info.error = (e as Error)?.message || String(e);
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

    // Alert management endpoints
    server.get('/api/alerts/rules', async (_request: FastifyRequest, reply: FastifyReply) => {
      const rules = this.alertManager.getRules();
      reply.send({ rules });
    });

    server.post('/api/alerts/check', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const routerMetrics = this.ctx.router.getMetrics();
        const registryStats = await this.ctx.serviceRegistry.getRegistryStats();
        const memUsage = process.memoryUsage();

        const alertMetrics = {
          successRate: this.sanitizeNumber(routerMetrics.successRate),
          averageResponseTime: this.sanitizeNumber(routerMetrics.averageResponseTime),
          totalRequests: this.sanitizeNumber(routerMetrics.totalRequests),
          memoryUsageMB: memUsage.heapUsed / 1024 / 1024,
          servicesError: this.sanitizeNumber(this.getStateCountMap(registryStats).error),
          servicesTotal: this.getServicesTotal(registryStats)
        };

        await this.alertManager.checkAndAlert(alertMetrics);
        reply.send({ status: 'checked', metrics: alertMetrics });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });
  }

  private updatePrometheusMetrics(routerMetrics: RouterMetricsSnapshot, registryStats: RegistryStatsSnapshot): void {
    const totalRequests = this.sanitizeNumber(routerMetrics.totalRequests);
    const successRate = this.sanitizeNumber(routerMetrics.successRate);
    const averageResponseTime = this.sanitizeNumber(routerMetrics.averageResponseTime);
    const servicesTotal = this.getServicesTotal(registryStats);
    const stateCount = this.getStateCountMap(registryStats);

    this.gatewayUptimeGauge.set(process.uptime() * 1000);
    this.syncRequestCounter(totalRequests);
    this.gatewaySuccessRateGauge.set(successRate);
    this.gatewayResponseTimeGauge.set(averageResponseTime);
    this.gatewayServicesTotalGauge.set(servicesTotal);
    this.gatewayServicesRunningGauge.set(this.sanitizeNumber(stateCount.running));
    this.gatewayServicesStoppedGauge.set(this.sanitizeNumber(stateCount.stopped));
    this.gatewayServicesErrorGauge.set(this.sanitizeNumber(stateCount.error));
  }

  private syncRequestCounter(totalRequests: number): void {
    if (totalRequests < this.lastObservedTotalRequests) {
      this.gatewayRequestsCounter.reset();
      this.gatewayRequestsCounter.inc(totalRequests);
      this.lastObservedTotalRequests = totalRequests;
      return;
    }

    const delta = totalRequests - this.lastObservedTotalRequests;
    if (delta > 0) {
      this.gatewayRequestsCounter.inc(delta);
    }
    this.lastObservedTotalRequests = totalRequests;
  }

  private getServicesTotal(registryStats: RegistryStatsSnapshot): number {
    const legacyStats = registryStats as unknown as { totalInstances?: unknown; instances?: unknown };
    return this.sanitizeNumber(legacyStats.totalInstances ?? legacyStats.instances);
  }

  private getStateCountMap(registryStats: RegistryStatsSnapshot): Record<string, number> {
    const map = (registryStats as unknown as { instancesByState?: unknown }).instancesByState;
    if (!map || typeof map !== 'object') {
      return {};
    }

    const result: Record<string, number> = {};
    for (const [state, count] of Object.entries(map as Record<string, unknown>)) {
      result[state] = this.sanitizeNumber(count);
    }
    return result;
  }

  private sanitizeNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, value);
  }
}
