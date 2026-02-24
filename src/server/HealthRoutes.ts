import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayRouter, ServiceRegistry } from '../types/index.js';

export interface HealthRoutesDeps {
  serviceRegistry: ServiceRegistry;
  authLayer: {
    getActiveTokenCount(): number;
    getActiveApiKeyCount(): number;
  };
  router: Pick<GatewayRouter, 'getMetrics'>;
}

export function registerHealthRoutes(server: FastifyInstance, deps: HealthRoutesDeps): void {
  const healthHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({ status: 'ok', ts: Date.now() });
  };
  server.get('/health', healthHandler);
  server.get('/api/health', healthHandler);

  server.get('/health/detailed', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        registry: await deps.serviceRegistry.getRegistryStats(),
        auth: {
          activeTokens: deps.authLayer.getActiveTokenCount(),
          activeApiKeys: deps.authLayer.getActiveApiKeyCount()
        },
        router: deps.router.getMetrics()
      }
    });
  });
}
