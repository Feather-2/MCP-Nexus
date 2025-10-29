import { z } from 'zod';

// MCP Protocol Versions
export const MCP_VERSIONS = ['2024-11-26', '2025-03-26', '2025-06-18'] as const;
export type McpVersion = typeof MCP_VERSIONS[number];

// Transport Types
export const TRANSPORT_TYPES = ['stdio', 'http', 'streamable-http'] as const;
export type TransportType = typeof TRANSPORT_TYPES[number];

// Service States
export const SERVICE_STATES = [
  'idle', 'initializing', 'starting', 'running', 'stopping', 
  'stopped', 'error', 'crashed', 'restarting', 'upgrading', 'maintenance'
] as const;
export type ServiceState = typeof SERVICE_STATES[number];

// Routing Strategies  
export const ROUTING_STRATEGIES = ['performance', 'cost', 'load-balance', 'content-aware'] as const;
export type RoutingStrategy = typeof ROUTING_STRATEGIES[number];

// Load Balancing Strategies
export const LOAD_BALANCING_STRATEGIES = ['round-robin', 'performance-based', 'cost-optimized', 'content-aware'] as const;
export type LoadBalancingStrategy = typeof LOAD_BALANCING_STRATEGIES[number];

// Orchestrator Modes
export const ORCHESTRATOR_MODES = ['manager-only', 'auto', 'wrapper-prefer'] as const;
export type OrchestratorMode = typeof ORCHESTRATOR_MODES[number];

// ===== AI Provider Config =====
export const AI_PROVIDERS = ['none', 'openai', 'anthropic', 'azure-openai', 'ollama'] as const;
export type AiProvider = typeof AI_PROVIDERS[number];

export const AiConfigSchema = z.object({
  provider: z.enum(AI_PROVIDERS).default('none'),
  model: z.string().optional().default(''),
  endpoint: z.string().optional().default(''),
  timeoutMs: z.number().optional().default(30000),
  streaming: z.boolean().optional().default(true)
}).partial();
export type AiConfig = z.infer<typeof AiConfigSchema>;

const PlannerConfigSchema = z.object({
  provider: z.enum(['local', 'remote']).default('local'),
  model: z.string().default('local-planner'),
  maxSteps: z.number().default(8),
  fallbackRemote: z.boolean().default(false)
});

const VectorStoreConfigSchema = z.object({
  provider: z.string().default('pgvector'),
  conn: z.string().optional(),
  table: z.string().optional(),
  embeddingModel: z.string().optional(),
  dim: z.number().optional()
}).partial();

const RerankerConfigSchema = z.object({
  provider: z.string().default('bge-reranker'),
  model: z.string().optional()
}).partial();

const ConcurrencyConfigSchema = z.object({
  global: z.number().default(8),
  perSubagent: z.number().default(2)
});

const BudgetConfigSchema = z.object({
  maxTokens: z.number().default(200_000),
  maxTimeMs: z.number().default(300_000),
  maxCostUsd: z.number().default(1.5),
  concurrency: ConcurrencyConfigSchema.default({})
}).partial();

const SwitchThresholdSchema = z.object({
  planDepth: z.number().default(6),
  failRate: z.number().default(0.3)
});

const RoutingConfigSchema = z.object({
  preferLocal: z.boolean().default(true),
  switchThreshold: SwitchThresholdSchema.default({})
}).partial();

export const SubagentConfigSchema = z.object({
  name: z.string().min(1),
  tools: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  maxConcurrency: z.number().default(1),
  weights: z.object({
    cost: z.number().default(0.5),
    performance: z.number().default(0.5)
  }).partial().default({}),
  policy: z.record(z.any()).optional()
});

export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(ORCHESTRATOR_MODES).default('manager-only'),
  planner: PlannerConfigSchema.default({}),
  vectorStore: VectorStoreConfigSchema.optional(),
  reranker: RerankerConfigSchema.optional(),
  budget: BudgetConfigSchema.optional(),
  routing: RoutingConfigSchema.optional(),
  subagentsDir: z.string().default('./config/subagents')
});

// Authentication Modes
export const AUTH_MODES = ['local-trusted', 'external-secure', 'dual'] as const;
export type AuthMode = typeof AUTH_MODES[number];

// Zod Schemas for validation
export const McpServiceConfigSchema = z.object({
  name: z.string().min(1, "Template name cannot be empty"),
  version: z.enum(MCP_VERSIONS),
  transport: z.enum(TRANSPORT_TYPES),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  workingDirectory: z.string().optional(),
  timeout: z.number().default(30000),
  retries: z.number().default(3),
  // Optional container sandbox settings (when transport === 'stdio')
  container: z.object({
    runtime: z.enum(['docker', 'podman']).optional(),
    image: z.string().optional(),
    workdir: z.string().optional(),
    network: z.string().optional(),
    readonlyRootfs: z.boolean().optional(),
    volumes: z.array(z.object({
      hostPath: z.string(),
      containerPath: z.string(),
      readOnly: z.boolean().optional()
    })).optional(),
    resources: z.object({
      cpus: z.union([z.number(), z.string()]).optional(),
      memory: z.string().optional()
    }).optional()
  }).optional(),
  healthCheck: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().default(5000),
    timeout: z.number().default(3000)
  }).optional()
});

export const GatewayConfigSchema = z.object({
  port: z.number().default(19233),
  host: z.string().default('127.0.0.1'),
  authMode: z.enum(AUTH_MODES).default('local-trusted'),
  routingStrategy: z.enum(ROUTING_STRATEGIES).default('performance'),
  loadBalancingStrategy: z.enum(LOAD_BALANCING_STRATEGIES).default('performance-based'),
  maxConcurrentServices: z.number().default(50),
  requestTimeout: z.number().default(30000),
  enableMetrics: z.boolean().default(true),
  enableHealthChecks: z.boolean().default(true),
  healthCheckInterval: z.number().default(30000),
  maxRetries: z.number().default(3),
  enableCors: z.boolean().default(true),
  corsOrigins: z.array(z.string()).default(['http://localhost:3000']),
  maxRequestSize: z.number().default(10 * 1024 * 1024),
  metricsRetentionDays: z.number().default(7),
  rateLimiting: z.object({
    enabled: z.boolean().default(false),
    maxRequests: z.number().default(100),
    windowMs: z.number().default(60000)
  }).default({}),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  // Non-secret AI configuration (keys read from environment variables)
  ai: AiConfigSchema.optional()
});

// Core Types
export type McpServiceConfig = z.infer<typeof McpServiceConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

// ===== MCP Generator Types =====
// (Moved after McpServiceConfigSchema to avoid circular reference)

// Source types for MCP generation
export const GENERATOR_SOURCE_TYPES = ['markdown', 'openapi', 'text', 'curl', 'javascript', 'python'] as const;
export type GeneratorSourceType = typeof GENERATOR_SOURCE_TYPES[number];

export const GENERATOR_EXPORT_FORMATS = ['json', 'npm', 'gist', 'typescript'] as const;
export type GeneratorExportFormat = typeof GENERATOR_EXPORT_FORMATS[number];

// Parse result from input sources
export const ParseResultSchema = z.object({
  intent: z.string(),
  endpoint: z.object({
    url: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    baseUrl: z.string().optional()
  }),
  auth: z.object({
    type: z.enum(['apikey', 'bearer', 'basic', 'oauth2', 'none']),
    location: z.enum(['header', 'query', 'body']).optional(),
    key: z.string().optional(),
    value: z.string().optional()
  }).optional(),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    required: z.boolean(),
    description: z.string().optional(),
    default: z.any().optional(),
    enum: z.array(z.any()).optional()
  })),
  response: z.object({
    schema: z.record(z.any()).optional(),
    examples: z.array(z.any()).optional()
  }).optional(),
  hasStatefulLogic: z.boolean().optional(),
  hasLocalProcessing: z.boolean().optional(),
  supportsStreaming: z.boolean().optional()
});

export type ParseResult = z.infer<typeof ParseResultSchema>;

// MCP Tool Schema
export const McpToolSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()),
    required: z.array(z.string()).optional()
  })
});

export type McpToolSchema = z.infer<typeof McpToolSchemaSchema>;

// Generator request
export const GenerateRequestSchema = z.object({
  source: z.object({
    type: z.enum(GENERATOR_SOURCE_TYPES),
    content: z.string().optional(),
    url: z.string().optional()
  }),
  options: z.object({
    name: z.string().optional(),
    transport: z.enum(['auto', 'http', 'stdio', 'streamable-http']).default('auto'),
    testMode: z.boolean().default(false),
    autoRegister: z.boolean().default(true)
  }).optional(),
  auth: z.record(z.string()).optional()
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

// Validation result
export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  dryRunResults: z.object({
    success: z.boolean(),
    response: z.any().optional(),
    latency: z.number(),
    error: z.string().optional()
  }).optional()
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// Generate response
export const GenerateResponseSchema = z.object({
  success: z.boolean(),
  template: z.object({
    name: z.string(),
    config: McpServiceConfigSchema,
    tools: z.array(McpToolSchemaSchema)
  }).optional(),
  validation: ValidationResultSchema.optional(),
  dryRun: z.object({
    success: z.boolean(),
    latency: z.number().optional(),
    error: z.string().optional()
  }).optional(),
  registered: z.boolean().optional(),
  serviceId: z.string().optional(),
  error: z.string().optional()
});

export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// Export request
export const ExportRequestSchema = z.object({
  templateName: z.string(),
  format: z.enum(GENERATOR_EXPORT_FORMATS),
  options: z.object({
    includeCode: z.boolean().default(true),
    includeTests: z.boolean().default(true),
    minify: z.boolean().default(false),
    metadata: z.object({
      author: z.string().optional(),
      tags: z.array(z.string()).optional(),
      description: z.string().optional()
    }).optional()
  }).optional()
});

export type ExportRequest = z.infer<typeof ExportRequestSchema>;

// Export response
export const ExportResponseSchema = z.object({
  success: z.boolean(),
  format: z.enum(GENERATOR_EXPORT_FORMATS),
  data: z.any().optional(),
  downloadUrl: z.string().optional(),
  shareUrl: z.string().optional(),
  error: z.string().optional()
});

export type ExportResponse = z.infer<typeof ExportResponseSchema>;

// Import request
export const ImportRequestSchema = z.object({
  source: z.object({
    type: z.enum(['json', 'url', 'gist']),
    content: z.any().optional(),
    url: z.string().optional(),
    gistId: z.string().optional()
  }),
  options: z.object({
    autoRegister: z.boolean().default(true),
    overwrite: z.boolean().default(false)
  }).optional()
});

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

// Import response
export const ImportResponseSchema = z.object({
  success: z.boolean(),
  template: z.object({
    name: z.string(),
    config: McpServiceConfigSchema
  }).optional(),
  registered: z.boolean().optional(),
  conflicts: z.array(z.string()).optional(),
  error: z.string().optional()
});

export type ImportResponse = z.infer<typeof ImportResponseSchema>;

// Marketplace template
export const MarketplaceTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  downloads: z.number().default(0),
  rating: z.number().min(0).max(5).optional(),
  tags: z.array(z.string()),
  preview: z.record(z.any()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type MarketplaceTemplate = z.infer<typeof MarketplaceTemplateSchema>;

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
  // Protocol Core
  sendMessage(serviceId: string, message: McpMessage): Promise<McpMessage>;
  receiveMessage(serviceId: string): Promise<McpMessage>;
  
  // Version Management
  negotiateVersion(serviceId: string, versions: McpVersion[]): Promise<McpVersion>;
  getCapabilities(serviceId: string): Promise<Record<string, any>>;
  
  // Process Management
  startProcess(config: McpServiceConfig): Promise<ServiceInstance>;
  stopProcess(serviceId: string): Promise<void>;
  restartProcess(serviceId: string): Promise<void>;
  getProcessInfo(serviceId: string): Promise<ServiceInstance | null>;
}

export interface ServiceRegistry extends EventEmitter {
  // Template Management
  registerTemplate(template: McpServiceConfig): Promise<void>;
  getTemplate(name: string): Promise<McpServiceConfig | null>;
  listTemplates(): Promise<McpServiceConfig[]>;
  
  // Instance Management
  createInstance(templateName: string, overrides?: Partial<McpServiceConfig>): Promise<ServiceInstance>;
  getInstance(serviceId: string): Promise<ServiceInstance | null>;
  listInstances(): Promise<ServiceInstance[]>;
  removeInstance(serviceId: string): Promise<void>;
  
  // Health & Load Balancing
  checkHealth(serviceId: string): Promise<HealthCheckResult>;
  getHealthyInstances(templateName?: string): Promise<ServiceInstance[]>;
  selectBestInstance(templateName: string, strategy?: RoutingStrategy): Promise<ServiceInstance | null>;
  
  // Health Monitoring
  startHealthMonitoring(): Promise<void>;
  stopHealthMonitoring(): Promise<void>;
  getHealthStatus(): Promise<Record<string, HealthCheckResult>>;
}

export interface ProtocolAdapters {
  // Transport Adapters
  createStdioAdapter(config: McpServiceConfig): Promise<TransportAdapter>;
  createHttpAdapter(config: McpServiceConfig): Promise<TransportAdapter>;
  createStreamableAdapter(config: McpServiceConfig): Promise<TransportAdapter>;
  
  // Protocol Detection
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
  // Authentication
  authenticate(request: AuthRequest): Promise<AuthResponse>;
  authorize(context: AuthContext, resource: string, action: string): Promise<boolean>;
  
  // Session Management
  createSession(context: AuthContext): Promise<string>;
  validateSession(token: string): Promise<AuthContext | null>;
  revokeSession(token: string): Promise<void>;
  
  // Security Features
  rateLimitCheck(identifier: string): Promise<boolean>;
  auditLog(event: string, context: AuthContext, details?: any): Promise<void>;
}

export interface GatewayRouter {
  // Route Management
  addRoute(pattern: string, handler: RouteHandler): void;
  removeRoute(pattern: string): void;
  
  // Request Routing
  route(request: RouteRequest): Promise<RouteResponse>;
  
  // Strategy Management
  setRoutingStrategy(strategy: LoadBalancingStrategy): void;
  getRoutingStrategy(): LoadBalancingStrategy;
  
  // Performance Monitoring
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
  // Configuration CRUD
  get<T = any>(key: string): Promise<T | null>;
  set<T = any>(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  
  // Batch operations
  getAll(): Promise<Record<string, any>>;
  setAll(config: Record<string, any>): Promise<void>;
  clear(): Promise<void>;
  
  // Configuration loading/saving
  loadConfig(): Promise<GatewayConfig>;
  saveConfig(config: GatewayConfig): Promise<void>;
  
  // Template management  
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
  healthCheck?: {
    enabled: boolean;
    interval: number;
    timeout: number;
  };
  description?: string;
  tags?: string[];
  capabilities?: string[]; // MCP capabilities this template provides
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
