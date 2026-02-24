import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type {
  AuthenticationLayer,
  ConfigManager,
  GatewayRouter,
  Logger,
  ProtocolAdapters,
  ServiceRegistry
} from '../../types/index.js';
import type { OrchestratorManager, OrchestratorStatus } from '../../orchestrator/OrchestratorManager.js';
import type { OrchestratorEngine } from '../../orchestrator/OrchestratorEngine.js';
import type { SubagentLoader } from '../../orchestrator/SubagentLoader.js';
import type { EventBus } from '../../events/bus.js';
import type { Middleware } from '../../middleware/types.js';
import { MiddlewareChain } from '../../middleware/chain.js';
import type { InstancePersistence } from '../../gateway/InstancePersistence.js';
import type { DeploymentPolicy } from '../../security/DeploymentPolicy.js';
import type { ToolListCache } from '../../gateway/ToolListCache.js';
import type { AdapterPool } from '../../adapters/AdapterPool.js';
import { parseOrReply as parseOrReplyUtil, type ParseOrReplyOptions } from './validation.js';

export interface RouteTemplateManager {
  initializeDefaults(): Promise<void>;
}

export interface RouteServiceRegistry extends ServiceRegistry {
  getTemplateManager(): RouteTemplateManager;
}

export interface RouteAuthenticationLayer extends AuthenticationLayer {
  listApiKeys(): Array<{
    id: string;
    name: string;
    key: string;
    permissions: string[];
    createdAt: string;
    lastUsed: string;
  }>;
  createApiKey(name: string, permissions: string[]): Promise<string>;
  deleteApiKey(apiKey: string): Promise<boolean>;
  listTokens(): Array<{
    token: string;
    userId: string;
    permissions: string[];
    expiresAt: string;
    lastUsed: string;
  }>;
  generateToken(userId: string, permissions: string[], expiresInHours?: number): Promise<string>;
  revokeToken(token: string): Promise<boolean>;
}

/**
 * Context shared across all route handlers
 */
export interface RouteContext {
  // --- Core (required by all routes) ---
  server: FastifyInstance;
  logger: Logger;
  serviceRegistry: RouteServiceRegistry;
  authLayer: RouteAuthenticationLayer;
  router: GatewayRouter;
  protocolAdapters: ProtocolAdapters;
  configManager: ConfigManager;

  // --- Orchestrator (OrchestratorRoutes, SkillRoutes) ---
  orchestratorManager?: OrchestratorManager;
  orchestratorEngine?: OrchestratorEngine;
  subagentLoader?: SubagentLoader;
  getOrchestratorStatus?: () => OrchestratorStatus | null;
  getOrchestratorEngine?: () => OrchestratorEngine | undefined;
  getSubagentLoader?: () => SubagentLoader | undefined;

  // --- Middleware (ToolRoutes, RoutingRoutes) ---
  middlewares?: Middleware[];
  middlewareChain?: MiddlewareChain;

  // --- Extensions (MonitoringRoutes, DeploymentRoutes) ---
  eventBus?: EventBus;
  instancePersistence?: InstancePersistence;
  deploymentPolicy?: DeploymentPolicy;
  toolListCache?: ToolListCache;
  adapterPool?: AdapterPool;

  // --- Shared state (LogRoutes, SandboxRoutes) ---
  logBuffer: Array<{ timestamp: string; level: string; message: string; service?: string; data?: unknown }>;
  logStreamClients: Set<FastifyReply>;
  sandboxStreamClients: Set<FastifyReply>;
  sandboxStatus: { nodeReady: boolean; pythonReady: boolean; goReady: boolean; packagesReady: boolean; details: Record<string, unknown> };
  sandboxInstalling: boolean;

  // --- Utility functions ---
  addLogEntry: (level: string, message: string, service?: string, data?: unknown) => void;
  respondError: (reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: unknown }) => unknown;
  canAcceptSseClient: () => boolean;
}

/**
 * Base class for route handlers
 */
export abstract class BaseRouteHandler {
  constructor(protected ctx: RouteContext) {}

  abstract setupRoutes(): void;

  protected respondError(reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: unknown }) {
    return this.ctx.respondError(reply, status, message, opts);
  }

  protected parseOrReply<TSchema extends z.ZodTypeAny>(
    reply: FastifyReply,
    schema: TSchema,
    payload: unknown,
    message: string,
    options?: ParseOrReplyOptions
  ): z.infer<TSchema> | null {
    return parseOrReplyUtil(reply, schema, payload, message, this.respondError.bind(this), options);
  }

  /**
   * Write SSE headers with proper CORS handling
   */
  protected writeSseHeaders(reply: FastifyReply, request: FastifyRequest): void {
    const origin = request.headers['origin'] as string | undefined;
    const cm = this.ctx.configManager;
    const config = typeof cm.getConfig === 'function' ? cm.getConfig() : (cm as unknown as { config?: Record<string, unknown> }).config || {};
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
