import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from '../../types/index.js';
import { ServiceRegistryImpl } from '../../gateway/ServiceRegistryImpl.js';
import { AuthenticationLayerImpl } from '../../auth/AuthenticationLayerImpl.js';
import { GatewayRouterImpl } from '../../router/GatewayRouterImpl.js';
import { ProtocolAdaptersImpl } from '../../adapters/ProtocolAdaptersImpl.js';
import { ConfigManagerImpl } from '../../config/ConfigManagerImpl.js';
import { OrchestratorManager } from '../../orchestrator/OrchestratorManager.js';
import { McpGenerator } from '../../generator/McpGenerator.js';

/**
 * Context shared across all route handlers
 */
export interface RouteContext {
  server: FastifyInstance;
  logger: Logger;
  serviceRegistry: ServiceRegistryImpl;
  authLayer: AuthenticationLayerImpl;
  router: GatewayRouterImpl;
  protocolAdapters: ProtocolAdaptersImpl;
  configManager: ConfigManagerImpl;
  orchestratorManager?: OrchestratorManager;
  mcpGenerator?: McpGenerator;

  // Shared state
  logBuffer: Array<{ timestamp: string; level: string; message: string; service?: string; data?: any }>;
  logStreamClients: Set<FastifyReply>;
  sandboxStreamClients: Set<FastifyReply>;
  sandboxStatus: { nodeReady: boolean; pythonReady: boolean; goReady: boolean; packagesReady: boolean; details: Record<string, any> };
  sandboxInstalling: boolean;

  // Utility functions
  addLogEntry: (level: string, message: string, service?: string, data?: any) => void;
  respondError: (reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: any }) => any;
}

/**
 * Base class for route handlers
 */
export abstract class BaseRouteHandler {
  constructor(protected ctx: RouteContext) {}

  abstract setupRoutes(): void;

  protected respondError(reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: any }) {
    return this.ctx.respondError(reply, status, message, opts);
  }
}
