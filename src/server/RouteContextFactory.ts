import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger, GatewayRouter, ProtocolAdapters, ConfigManager } from '../types/index.js';
import type { Middleware } from '../middleware/types.js';
import { MiddlewareChain } from '../middleware/chain.js';
import type { OrchestratorStatus, OrchestratorManager } from '../orchestrator/OrchestratorManager.js';
import type { OrchestratorEngine } from '../orchestrator/OrchestratorEngine.js';
import type { SubagentLoader } from '../orchestrator/SubagentLoader.js';
import type { EventBus } from '../events/bus.js';
import type { InstancePersistence } from '../gateway/InstancePersistence.js';
import type { DeploymentPolicy } from '../security/DeploymentPolicy.js';
import type { ToolListCache } from '../gateway/ToolListCache.js';
import type { AdapterPool } from '../adapters/AdapterPool.js';
import type {
  RouteAuthenticationLayer,
  RouteContext,
  RouteServiceRegistry
} from './routes/RouteContext.js';

export interface RouteContextFactoryInput {
  server: FastifyInstance;
  logger: Logger;
  serviceRegistry: RouteServiceRegistry;
  authLayer: RouteAuthenticationLayer;
  router: GatewayRouter;
  protocolAdapters: ProtocolAdapters;
  configManager: ConfigManager;
  getOrchestratorManager: () => OrchestratorManager | undefined;
  getOrchestratorEngine: () => OrchestratorEngine | undefined;
  getSubagentLoader: () => SubagentLoader | undefined;
  getOrchestratorStatus: () => OrchestratorStatus | null;
  middlewares: Middleware[];
  middlewareChain: MiddlewareChain;
  eventBus?: EventBus;
  getInstancePersistence: () => InstancePersistence | undefined;
  getDeploymentPolicy: () => DeploymentPolicy | undefined;
  getToolListCache: () => ToolListCache | undefined;
  getAdapterPool: () => AdapterPool | undefined;
  logBuffer: Array<{ timestamp: string; level: string; message: string; service?: string; data?: unknown }>;
  logStreamClients: Set<FastifyReply>;
  sandboxStreamClients: Set<FastifyReply>;
  sandboxStatus: { nodeReady: boolean; pythonReady: boolean; goReady: boolean; packagesReady: boolean; details: Record<string, unknown> };
  getSandboxInstalling: () => boolean;
  setSandboxInstalling: (value: boolean) => void;
  addLogEntry: (level: string, message: string, service?: string, data?: unknown) => void;
  respondError: (reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: unknown }) => unknown;
  canAcceptSseClient: () => boolean;
}

export function buildRouteContext(input: RouteContextFactoryInput): RouteContext {
  return {
    server: input.server,
    logger: input.logger,
    serviceRegistry: input.serviceRegistry,
    authLayer: input.authLayer,
    router: input.router,
    protocolAdapters: input.protocolAdapters,
    configManager: input.configManager,
    get orchestratorManager() { return input.getOrchestratorManager(); },
    get orchestratorEngine() { return input.getOrchestratorEngine(); },
    get subagentLoader() { return input.getSubagentLoader(); },
    getOrchestratorStatus: input.getOrchestratorStatus,
    getOrchestratorEngine: input.getOrchestratorEngine,
    getSubagentLoader: input.getSubagentLoader,
    middlewares: input.middlewares,
    middlewareChain: input.middlewareChain,
    eventBus: input.eventBus,
    get instancePersistence() { return input.getInstancePersistence(); },
    get deploymentPolicy() { return input.getDeploymentPolicy(); },
    get toolListCache() { return input.getToolListCache(); },
    get adapterPool() { return input.getAdapterPool(); },
    logBuffer: input.logBuffer,
    logStreamClients: input.logStreamClients,
    sandboxStreamClients: input.sandboxStreamClients,
    sandboxStatus: input.sandboxStatus,
    get sandboxInstalling() { return input.getSandboxInstalling(); },
    set sandboxInstalling(value: boolean) { input.setSandboxInstalling(value); },
    addLogEntry: input.addLogEntry,
    respondError: input.respondError,
    canAcceptSseClient: input.canAcceptSseClient
  };
}

