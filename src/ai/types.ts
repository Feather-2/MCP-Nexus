// 1. Provider ID
export type AiProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'groq'
  | 'deepseek'
  | 'ollama'
  | 'azure'
  | 'bedrock';

// 2. Key 轮换模式
export type KeyRotationMode = 'polling' | 'random';

// 3. Key 状态
export interface KeyState {
  index: number;
  enabled: boolean;
  disabledAt?: Date;
  disabledUntil?: Date;
  disabledReason?: string;
  errorCount: number;
  lastUsedAt?: Date;
  totalRequests: number;
  totalTokens: number;
}

// 4. Key 来源配置
export interface KeySource {
  type: 'env' | 'literal';
  value: string; // env var name or literal key(s)
  format: 'single' | 'newline' | 'json';
}

// 5. Channel 配置
export interface ChannelConfig {
  id: string;
  name?: string;
  provider: AiProviderId;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  keySource: KeySource;
  keyRotation?: KeyRotationMode;
  weight?: number; // for load balancing, default 1
  enabled?: boolean;
  rateLimit?: {
    rpm?: number; // requests per minute
    tpm?: number; // tokens per minute
  };
  timeout?: number;
  tags?: string[];
}

// 6. Channel 运行时状态
export interface ChannelState {
  channelId: string;
  enabled: boolean;
  keys: KeyState[];
  pollingIndex: number;
  consecutiveFailures: number;
  cooldownUntil?: Date;
  metrics: {
    totalRequests: number;
    totalErrors: number;
    avgLatencyMs: number;
    lastRequestAt?: Date;
  };
}

// 7. Lease（租约，调用时获取）
export interface ChannelLease {
  channelId: string;
  keyIndex: number;
  apiKey: string;
  provider: AiProviderId;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  attempt: number;
  acquiredAt: Date;
}

// 8. AI 请求
export interface AiRequest {
  messages: AiMessage[];
  model?: string; // override channel model
  temperature?: number;
  maxTokens?: number;
  tools?: AiTool[];
  stream?: boolean;
}

// 9. AI 消息（兼容 Vercel AI SDK）
export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | AiContentPart[];
  toolCallId?: string;
  toolCalls?: AiToolCall[];
}

export interface AiContentPart {
  type: 'text' | 'image';
  text?: string;
  image?: string | Uint8Array;
  mimeType?: string;
}

export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// 10. AI 响应
export interface AiResult {
  text: string;
  toolCalls?: AiToolCall[];
  usage: AiUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  latencyMs: number;
  channelId: string;
  keyIndex: number;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// 11. AI 错误分类
export type AiErrorType =
  | 'rate_limit' // 429
  | 'auth' // 401, 403
  | 'invalid_request' // 400
  | 'server_error' // 5xx
  | 'timeout'
  | 'network'
  | 'unknown';

export class AiError extends Error {
  constructor(
    message: string,
    public readonly type: AiErrorType,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'AiError';
  }
}

// 12. Rate Limit 配置
export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

// 13. Cost 配置
export interface ModelPricing {
  promptPer1kTokens: number; // USD
  completionPer1kTokens: number;
}

export interface CostConfig {
  pricing: Record<string, ModelPricing>;
  budgetUsd?: number;
  budgetPeriod?: 'hour' | 'day' | 'month';
}

/**
 * Attribution context for cost tracking.
 */
export interface CostAttribution {
  /** Skill ID that triggered the request. */
  skillId?: string;
  /** Service/instance ID that handled the request. */
  serviceId?: string;
  /** Unique request ID for tracing. */
  requestId?: string;
}

// 14. AI Client 配置
export interface AiClientConfig {
  channels: ChannelConfig[];
  defaultChannel?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  rateLimit?: RateLimitConfig;
  cost?: CostConfig;
}
