import { z } from 'zod';
import {
  MCP_VERSIONS,
  TRANSPORT_TYPES,
  ROUTING_STRATEGIES,
  LOAD_BALANCING_STRATEGIES,
  SECURITY_PROFILES
} from './mcp.js';
import { AiConfigSchema } from './ai.js';

// Authentication Modes
export const AUTH_MODES = ['local-trusted', 'external-secure', 'dual'] as const;
export type AuthMode = typeof AUTH_MODES[number];

// Portable sandbox config
const PortableSandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  inheritSystemPath: z.boolean().default(false),
  allowDangerousEnvOverride: z.boolean().default(false),
  networkPolicy: z.enum(['full', 'local-only', 'blocked']).default('local-only')
}).partial().default({});

// Container sandbox config
const ContainerSandboxConfigSchema = z.object({
  prefer: z.boolean().default(false),
  requiredForUntrusted: z.boolean().default(false),
  defaultNetwork: z.enum(['none', 'bridge']).default('none'),
  defaultReadonlyRootfs: z.boolean().default(true),
  allowedVolumeRoots: z.array(z.string()).default(['../mcp-sandbox', './data']),
  envSafePrefixes: z.array(z.string()).default(['PB_', 'PBMCP_', 'MCP_', 'BRAVE_'])
}).partial().default({});

const SandboxConfigSchema = z.object({
  profile: z.enum(SECURITY_PROFILES).default('default'),
  portable: PortableSandboxConfigSchema,
  container: ContainerSandboxConfigSchema
}).partial().default({});

// Skills system config
const SkillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  roots: z.array(z.string()).optional(),
  managedRoot: z.string().optional(),
  allowedTools: z.array(z.string()).optional()
}).partial();

// MCP Service Config Schema
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
      memory: z.string().optional(),
      pidsLimit: z.number().optional()
    }).optional(),
    // Security hardening
    seccompProfile: z.string().optional(),
    noNewPrivileges: z.boolean().optional(),
    dropCapabilities: z.array(z.string()).optional()
  }).optional(),
  security: z.object({
    trustLevel: z.enum(['trusted', 'partner', 'untrusted']).default('trusted'),
    networkPolicy: z.enum(['inherit', 'full', 'local-only', 'blocked']).default('inherit'),
    requireContainer: z.boolean().default(false)
  }).optional(),
  healthCheck: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().default(5000),
    timeout: z.number().default(3000)
  }).optional()
});

// Rate limiting config
const RateLimitingConfigSchema = z.object({
  enabled: z.boolean(),
  maxRequests: z.number(),
  windowMs: z.number(),
  store: z.enum(['memory', 'redis']),
  redis: z.object({
    url: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    db: z.number().optional(),
    tls: z.boolean().optional()
  }).optional()
}).partial().default({
  enabled: false,
  maxRequests: 100,
  windowMs: 60000,
  store: 'memory'
});

// Gateway Config Schema
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
  rateLimiting: RateLimitingConfigSchema.default({
    enabled: false,
    maxRequests: 100,
    windowMs: 60000,
    store: 'memory'
  }),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  sandbox: SandboxConfigSchema.optional(),
  ai: AiConfigSchema.optional(),
  skills: SkillsConfigSchema.optional()
});

// Core Types
export type McpServiceConfig = z.infer<typeof McpServiceConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
