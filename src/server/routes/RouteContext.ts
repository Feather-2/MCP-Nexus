import { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../types/index.js';
import { ServiceRegistryImpl } from '../../gateway/ServiceRegistryImpl.js';
import { AuthenticationLayerImpl } from '../../auth/AuthenticationLayerImpl.js';
import { GatewayRouterImpl } from '../../router/GatewayRouterImpl.js';
import { ProtocolAdaptersImpl } from '../../adapters/ProtocolAdaptersImpl.js';
import { ConfigManagerImpl } from '../../config/ConfigManagerImpl.js';
import type { OrchestratorManager, OrchestratorStatus } from '../../orchestrator/OrchestratorManager.js';
import type { OrchestratorEngine } from '../../orchestrator/OrchestratorEngine.js';
import type { SubagentLoader } from '../../orchestrator/SubagentLoader.js';
import type { McpGenerator } from '../../generator/McpGenerator.js';
import type { Middleware } from '../../middleware/types.js';
import { MiddlewareChain } from '../../middleware/chain.js';

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
  orchestratorEngine?: OrchestratorEngine;
  subagentLoader?: SubagentLoader;
  mcpGenerator?: McpGenerator;
  getOrchestratorStatus?: () => OrchestratorStatus | null;
  getOrchestratorEngine?: () => OrchestratorEngine | undefined;
  getSubagentLoader?: () => SubagentLoader | undefined;
  middlewares?: Middleware[];
  middlewareChain?: MiddlewareChain;

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
