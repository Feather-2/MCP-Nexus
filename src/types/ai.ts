import { z } from 'zod';
import { ORCHESTRATOR_MODES, SECURITY_PROFILES } from './mcp.js';

// ===== AI Provider Config =====
export const AI_PROVIDERS = [
  'none', 'openai', 'anthropic', 'azure-openai', 'ollama',
  'google', 'mistral', 'groq', 'deepseek', 'bedrock'
] as const;
export type AiProvider = typeof AI_PROVIDERS[number];

// Key source configuration for channels
export const KeySourceSchema = z.object({
  type: z.enum(['env', 'literal']),
  value: z.string(),
  format: z.enum(['single', 'newline', 'json']).default('single')
});
export type KeySource = z.infer<typeof KeySourceSchema>;

// Channel configuration schema
export const ChannelConfigSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(['openai', 'anthropic', 'google', 'mistral', 'groq', 'deepseek', 'ollama', 'azure-openai', 'bedrock']),
  model: z.string().min(1),
  keySource: KeySourceSchema,
  keyRotation: z.enum(['polling', 'random']).default('polling'),
  weight: z.number().min(0).default(1),
  enabled: z.boolean().default(true),
  baseUrl: z.string().optional(),
  headers: z.record(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  rateLimit: z.object({
    rpm: z.number().optional(),
    tpm: z.number().optional()
  }).optional()
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

export const AiConfigSchema = z.object({
  provider: z.enum(AI_PROVIDERS).default('none'),
  model: z.string().optional().default(''),
  endpoint: z.string().optional().default(''),
  timeoutMs: z.number().optional().default(30000),
  streaming: z.boolean().optional().default(true),
  channels: z.array(ChannelConfigSchema).optional(),
  budget: z.object({
    maxCostUsd: z.number().optional(),
    period: z.enum(['hour', 'day', 'month']).optional()
  }).optional()
}).partial();
export type AiConfig = z.infer<typeof AiConfigSchema>;

// Orchestrator internal schemas (not exported directly, used by OrchestratorConfigSchema)
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

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;
