import type {
  McpVersion,
  TransportType,
  ServiceState,
  RoutingStrategy,
  LoadBalancingStrategy
} from './mcp.js';
import type { AuthMode } from './gateway.js';
import type { McpServiceConfig, GatewayConfig } from './gateway.js';

// Message Types
export interface McpMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Service Instance
export interface ServiceInstance {
  id: string;
  config: McpServiceConfig;
  state: ServiceState;
  pid?: number;
  startTime?: Date;
  startedAt: Date;
  lastHealthCheck?: Date;
  errorCount: number;
  metadata: Record<string, any>;
}

// Health Check Result
export interface HealthCheckResult {
  healthy: boolean;
  latency?: number;
  error?: string;
  timestamp: Date;
}

// Load Balancer Metrics
export interface LoadBalancerMetrics {
  serviceId: string;
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  addedAt: Date;
  lastRequestTime: Date;
}

// Authentication Context
export interface AuthContext {
  mode: AuthMode;
  userId?: string;
  permissions: string[];
  token?: string;
  apiKey?: string;
  expiresAt?: Date;
  trusted?: boolean;
}

// Authentication Request/Response
export interface AuthRequest {
  token?: string;
  apiKey?: string;
  clientIp?: string;
  method?: string;
  resource?: string;
  credentials?: any;
}

export interface AuthResponse {
  success: boolean;
  context?: AuthContext;
  error?: string;
}

// Gateway Events
export type GatewayEvent =
  | { type: 'service-started'; serviceId: string; instance: ServiceInstance }
  | { type: 'service-stopped'; serviceId: string; reason?: string }
  | { type: 'service-error'; serviceId: string; error: Error }
  | { type: 'service-health-changed'; serviceId: string; healthy: boolean }
  | { type: 'gateway-started'; config: GatewayConfig }
  | { type: 'gateway-stopped' }
  | { type: 'auth-failed'; context: Partial<AuthContext> };

// Core Interfaces
export interface McpProtocolStack {
  sendMessage(serviceId: string, message: McpMessage): Promise<McpMessage>;
  receiveMessage(serviceId: string): Promise<McpMessage>;
  negotiateVersion(serviceId: string, versions: McpVersion[]): Promise<McpVersion>;
  getCapabilities(serviceId: string): Promise<Record<string, any>>;
  startProcess(config: McpServiceConfig): Promise<ServiceInstance>;
  stopProcess(serviceId: string): Promise<void>;
  restartProcess(serviceId: string): Promise<void>;
  getProcessInfo(serviceId: string): Promise<ServiceInstance | null>;
}

export interface ServiceRegistry extends EventEmitter {
  registerTemplate(template: McpServiceConfig): Promise<void>;
  getTemplate(name: string): Promise<McpServiceConfig | null>;
  listTemplates(): Promise<McpServiceConfig[]>;
  createInstance(templateName: string, overrides?: Partial<McpServiceConfig>): Promise<ServiceInstance>;
  getInstance(serviceId: string): Promise<ServiceInstance | null>;
  listInstances(): Promise<ServiceInstance[]>;
  removeInstance(serviceId: string): Promise<void>;
  checkHealth(serviceId: string): Promise<HealthCheckResult>;
  getHealthyInstances(templateName?: string): Promise<ServiceInstance[]>;
  selectBestInstance(templateName: string, strategy?: RoutingStrategy): Promise<ServiceInstance | null>;
  startHealthMonitoring(): Promise<void>;
  stopHealthMonitoring(): Promise<void>;
  getHealthStatus(): Promise<Record<string, HealthCheckResult>>;
}

export interface ProtocolAdapters {
  createStdioAdapter(config: McpServiceConfig): Promise<TransportAdapter>;
  createHttpAdapter(config: McpServiceConfig): Promise<TransportAdapter>;
  createStreamableAdapter(config: McpServiceConfig): Promise<TransportAdapter>;
  detectProtocol(endpoint: string): Promise<TransportType>;
  validateProtocol(adapter: TransportAdapter, version: McpVersion): Promise<boolean>;
}

export interface TransportAdapter {
  readonly type: TransportType;
  readonly version: McpVersion;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: McpMessage): Promise<void>;
  receive(): Promise<McpMessage>;
  isConnected(): boolean;
}

export interface AuthenticationLayer {
  authenticate(request: AuthRequest): Promise<AuthResponse>;
  authorize(context: AuthContext, resource: string, action: string): Promise<boolean>;
  createSession(context: AuthContext): Promise<string>;
  validateSession(token: string): Promise<AuthContext | null>;
  revokeSession(token: string): Promise<void>;
  rateLimitCheck(identifier: string): Promise<boolean>;
  auditLog(event: string, context: AuthContext, details?: any): Promise<void>;
}

export interface GatewayRouter {
  addRoute(pattern: string, handler: RouteHandler): void;
  removeRoute(pattern: string): void;
  route(request: RouteRequest): Promise<RouteResponse>;
  setRoutingStrategy(strategy: LoadBalancingStrategy): void;
  getRoutingStrategy(): LoadBalancingStrategy;
  getMetrics(): {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    serviceDistribution: Record<string, number>;
    strategyEffectiveness: Record<LoadBalancingStrategy, number>;
  };
  resetMetrics(): Promise<void>;
}

export interface RouteHandler {
  (request: GatewayRequest, context: AuthContext): Promise<GatewayResponse>;
}

export interface GatewayRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
  timestamp: Date;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body?: any;
  timestamp: Date;
}

// Event System
export interface EventEmitter<T = any> {
  on(event: string, listener: (data: T) => void): void;
  off(event: string, listener: (data: T) => void): void;
  emit(event: string, data: T): void;
}

// Logger Interface
export interface Logger {
  trace(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}

// Configuration Management
export interface ConfigManager {
  get<T = any>(key: string): Promise<T | null>;
  set<T = any>(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  getAll(): Promise<Record<string, any>>;
  setAll(config: Record<string, any>): Promise<void>;
  clear(): Promise<void>;
  loadConfig(): Promise<GatewayConfig>;
  saveConfig(config: GatewayConfig): Promise<void>;
  loadTemplates(): Promise<void>;
  saveTemplates(): Promise<void>;
}

// Service Template
export interface ServiceTemplate {
  name: string;
  version: McpVersion;
  transport: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  timeout?: number;
  retries?: number;
  container?: {
    runtime?: 'docker' | 'podman';
    image?: string;
    workdir?: string;
    network?: string;
    readonlyRootfs?: boolean;
    volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
    resources?: {
      cpus?: number | string;
      memory?: string;
      pidsLimit?: number;  // Prevent fork bomb attacks
    };
    // Security hardening options
    seccompProfile?: string;        // Path to seccomp profile JSON
    noNewPrivileges?: boolean;      // Default: true - prevent privilege escalation
    dropCapabilities?: string[];    // Capabilities to drop (e.g., ['NET_RAW', 'SYS_ADMIN'])
  };
  security?: {
    trustLevel?: 'trusted' | 'partner' | 'untrusted';
    networkPolicy?: 'inherit' | 'full' | 'local-only' | 'blocked';
    requireContainer?: boolean;
  };
  healthCheck?: {
    enabled: boolean;
    interval: number;
    timeout: number;
  };
  description?: string;
  tags?: string[];
  capabilities?: string[];
}

// Service Health
export interface ServiceHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTime: number;
  lastCheck: Date;
  error?: string;
  metrics?: {
    cpu?: number;
    memory?: number;
    connections?: number;
  };
}

// Service Load Metrics
export interface ServiceLoadMetrics {
  requestCount: number;
  successRate: number;
  averageResponseTime: number;
  lastUsed: Date;
}

// Service Cost Metrics
export interface ServiceCostMetrics {
  costPerRequest: number;
  totalCost: number;
  costEfficiency: number;
}

// Service Content Analysis
export interface ServiceContentAnalysis {
  supportedContentTypes: string[];
  specializedMethods: string[];
  maxContentLength: number;
  averageProcessingTime: number;
}

// Routing Types
export interface RouteRequest {
  method: string;
  params?: any;
  serviceGroup?: string;
  contentType?: string;
  contentLength?: number;
  clientIp: string;
  availableServices: ServiceInstance[];
  serviceHealthMap: Map<string, ServiceHealth>;
}

export interface RouteResponse {
  success: boolean;
  selectedService?: ServiceInstance;
  error?: string;
  routingDecision?: {
    strategy: LoadBalancingStrategy;
    reason: string;
    appliedRules: string[];
  };
}

export interface RoutingRule {
  name: string;
  enabled: boolean;
  priority?: number;
  condition: any;
  action: {
    type: 'allow' | 'deny' | 'redirect' | 'balance' | 'filter' | 'prefer' | 'reject';
    target?: string;
    weight?: number;
    criteria?: any;
    targetServiceGroup?: string;
  };
}
