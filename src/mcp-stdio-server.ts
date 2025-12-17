#!/usr/bin/env node
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_VERSIONS } from './types/index.js';
import type { Logger, McpVersion } from './types/index.js';
import { TierRouter } from './routing/tier-router.js';
import { DelegateTool } from './routing/delegate.js';
import type { SubAgentExecutor, SubAgentResult } from './routing/delegate.js';
import { UnifiedAiClient } from './ai/client.js';
import { ChannelManager } from './ai/channel.js';
import type { AiClientConfig } from './ai/types.js';

type JsonRpcId = string | number | null;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type StdioToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
};

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional()
});
type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

const ToolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional()
});

const RouteTaskArgsSchema = z.object({
  task: z.string().min(1)
});

const DelegateArgsSchema = z.object({
  department: z.enum(['research', 'coding', 'review', 'testing', 'docs']),
  task: z.string().min(1),
  context: z.record(z.unknown()).optional(),
  returnMode: z.enum(['simple', 'step', 'overview', 'details']).optional()
});

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return data === undefined ? { code, message } : { code, message, data };
}

function toTextResult(value: unknown): McpToolCallResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function latestSupportedVersion(): McpVersion {
  const sorted = [...MCP_VERSIONS].sort((a, b) => b.localeCompare(a));
  return sorted[0] ?? '2024-11-26';
}

function pickProtocolVersion(requested: unknown): McpVersion {
  if (typeof requested !== 'string') return latestSupportedVersion();
  const match = MCP_VERSIONS.find((v) => v === requested);
  return match ?? latestSupportedVersion();
}

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

function createStderrLogger(level: LogLevel = 'info'): Logger {
  const levels: Record<LogLevel | 'silent', number> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5
  };
  const threshold = levels[level] ?? levels.info;

  const emit = (lvl: keyof typeof levels, message: string, meta?: unknown): void => {
    if ((levels[lvl] ?? 0) > threshold) return;
    const ts = new Date().toISOString();
    const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
    process.stderr.write(`[${ts}] ${lvl.toUpperCase()} ${message}${suffix}\n`);
  };

  return {
    trace: (message, meta) => emit('trace', message, meta),
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta)
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[Unserializable]"';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}

type GatewayAiRuntimeConfig = {
  channels?: unknown[];
  retryAttempts?: number;
  retryDelayMs?: number;
};

function loadGatewayAiConfig(logger: Logger): GatewayAiRuntimeConfig {
  const configPath = join(process.cwd(), 'config', 'gateway.json');
  let parsed: unknown = undefined;

  try {
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim().length > 0) {
      parsed = JSON.parse(raw) as unknown;
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT') {
      logger.warn('Failed to load gateway config', {
        message: error instanceof Error ? error.message : String(error),
        configPath
      });
    }
  }

  if (!isRecord(parsed)) return {};
  const ai = parsed['ai'];
  if (!isRecord(ai)) return {};

  const channels = Array.isArray(ai['channels']) ? (ai['channels'] as unknown[]) : undefined;
  const retryAttempts = asFiniteNumber(ai['retryAttempts']);
  const retryDelayMs = asFiniteNumber(ai['retryDelayMs']);

  return { channels, retryAttempts, retryDelayMs };
}

function normalizeAiChannels(channels: readonly unknown[]): AiClientConfig['channels'] {
  return channels
    .filter((channel) => {
      if (!isRecord(channel)) return false;
      const provider = channel['provider'];
      return provider !== 'none';
    })
    .map((channel) => {
      if (!isRecord(channel)) return channel;
      const provider = channel['provider'];
      if (provider === 'azure-openai') {
        return { ...channel, provider: 'azure' };
      }
      return channel;
    }) as unknown as AiClientConfig['channels'];
}

class AiSubAgentExecutor implements SubAgentExecutor {
  constructor(private readonly aiClient: UnifiedAiClient) {}

  async execute(department: string, task: string, context?: Record<string, unknown>): Promise<SubAgentResult> {
    const systemPrompt = this.buildSystemPrompt(department);
    const userMessage = this.buildUserMessage(task, context);

    try {
      const result = await this.aiClient.generate({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        maxTokens: 4096
      });

      return {
        success: true,
        output: result.text,
        artifacts: this.extractArtifacts(result.text)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `AI delegation failed: ${message}`,
        error: message
      };
    }
  }

  private buildSystemPrompt(department: string): string {
    const prompts: Record<string, string> = {
      research:
        'You are a research specialist. Analyze information thoroughly and provide comprehensive findings.',
      coding: 'You are an expert developer. Write clean, efficient, well-documented code.',
      review: 'You are a code reviewer. Identify issues, suggest improvements, and ensure quality.',
      testing: 'You are a QA specialist. Design and implement comprehensive test cases.',
      docs: 'You are a technical writer. Create clear, accurate documentation.'
    };
    return prompts[department] || 'You are a helpful assistant.';
  }

  private buildUserMessage(task: string, context?: Record<string, unknown>): string {
    let message = task;
    if (context && Object.keys(context).length > 0) {
      message += '\n\nContext:\n' + JSON.stringify(context, null, 2);
    }
    return message;
  }

  private extractArtifacts(text: string): string[] {
    const artifacts: string[] = [];
    const codeBlockRegex = /```(?:\w+)?\s*\n[\s\S]*?```/g;
    const matches = text.match(codeBlockRegex);
    if (matches) {
      artifacts.push(`${matches.length} code blocks`);
    }
    return artifacts;
  }
}

class McpStdioServer {
  private readonly logger: Logger;
  private readonly tierRouter = new TierRouter();
  private readonly delegateTool: DelegateTool;
  private readonly tools: StdioToolDefinition[];

  constructor(logger: Logger) {
    this.logger = logger;

    const aiConfig = loadGatewayAiConfig(this.logger);
    const configuredChannels = aiConfig.channels;

    const executor: SubAgentExecutor =
      configuredChannels && configuredChannels.length > 0
        ? new AiSubAgentExecutor(
            new UnifiedAiClient(
              new ChannelManager({ channels: normalizeAiChannels(configuredChannels) }),
              {
                retryAttempts: aiConfig.retryAttempts,
                retryDelayMs: aiConfig.retryDelayMs
              }
            )
          )
        : {
            execute: async () => {
              const message =
                'No AI channels configured. Set `ai.channels` in `config/gateway.json` and provide API keys via the configured `keySource`.';
              return { success: false, output: message, error: message };
            }
          };

    this.delegateTool = new DelegateTool({ executor });

    this.tools = [
      {
        name: 'route_task',
        description: 'Analyze task complexity and suggest routing tier (direct/skills/subagent)',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description to analyze' }
          },
          required: ['task']
        }
      },
      {
        name: 'delegate',
        description: 'Delegate complex task to specialized SubAgent for isolated execution. Returns summary by default; use returnMode to control detail level.',
        inputSchema: {
          type: 'object',
          properties: {
            department: {
              type: 'string',
              enum: ['research', 'coding', 'review', 'testing', 'docs'],
              description: 'Specialized department to handle the task'
            },
            task: { type: 'string', description: 'Task description' },
            context: { type: 'object', description: 'Optional context' },
            returnMode: {
              type: 'string',
              enum: ['simple', 'step', 'overview', 'details'],
              default: 'simple',
              description: 'Controls response detail: simple (result only ~300b), step (per-step ~1-2KB), overview (summary ~500b-1KB), details (full debug ~5-50KB)'
            }
          },
          required: ['department', 'task']
        }
      }
    ];
  }

  async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: jsonRpcError(-32700, 'Parse error', { message: error instanceof Error ? error.message : String(error) })
      };
      writeJsonLine(response);
      return;
    }

    const requestResult = JsonRpcRequestSchema.safeParse(parsed);
    if (!requestResult.success) {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: jsonRpcError(-32600, 'Invalid Request', requestResult.error.flatten())
      };
      writeJsonLine(response);
      return;
    }

    const request = requestResult.data;
    const id: JsonRpcId = request.id ?? null;

    if (request.id === undefined) {
      await this.handleNotification(request);
      return;
    }

    try {
      const result = await this.dispatch(request);
      const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
      writeJsonLine(response);
    } catch (error) {
      if (error instanceof JsonRpcDispatchError) {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id,
          error: jsonRpcError(error.code, error.message, error.data)
        };
        writeJsonLine(response);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: jsonRpcError(-32603, 'Internal error', { message })
      };
      writeJsonLine(response);
    }
  }

  private async handleNotification(request: JsonRpcRequest): Promise<void> {
    // MCP clients may send notifications like "initialized" or "notifications/initialized".
    this.logger.debug('Ignoring notification', { method: request.method });
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request.params);
      case 'tools/list':
        return this.handleToolsList();
      case 'tools/call':
        return await this.handleToolsCall(request.params);
      default:
        throw new JsonRpcDispatchError(-32601, `Method not found: ${request.method}`);
    }
  }

  private handleInitialize(params: unknown): unknown {
    const paramsObj = params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined;
    const requested = paramsObj?.protocolVersion;
    const protocolVersion = pickProtocolVersion(requested);

    return {
      protocolVersion,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'pb-mcpgateway',
        version: '1.0.0'
      }
    };
  }

  private handleToolsList(): unknown {
    return { tools: this.tools };
  }

  private async handleToolsCall(params: unknown): Promise<unknown> {
    const parsed = ToolsCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new JsonRpcDispatchError(-32602, 'Invalid params', parsed.error.flatten());
    }

    const toolName = parsed.data.name;
    const args = parsed.data.arguments ?? {};

    if (toolName === 'route_task') {
      const argsParsed = RouteTaskArgsSchema.safeParse(args);
      if (!argsParsed.success) {
        throw new JsonRpcDispatchError(-32602, 'Invalid params', argsParsed.error.flatten());
      }

      const { decision, complexity } = this.tierRouter.routeWithComplexity(argsParsed.data.task);
      return toTextResult({ decision, complexity });
    }

    if (toolName === 'delegate') {
      const argsParsed = DelegateArgsSchema.safeParse(args);
      if (!argsParsed.success) {
        throw new JsonRpcDispatchError(-32602, 'Invalid params', argsParsed.error.flatten());
      }

      const response = await this.delegateTool.delegate({
        department: argsParsed.data.department,
        task: argsParsed.data.task,
        context: argsParsed.data.context,
        returnMode: argsParsed.data.returnMode
      });
      return toTextResult(response);
    }

    throw new JsonRpcDispatchError(-32601, `Unknown tool: ${toolName}`);
  }
}

class JsonRpcDispatchError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
  }
}

async function main(): Promise<void> {
  const rawLevel = process.env.PB_MCP_LOG_LEVEL;
  const level: LogLevel =
    rawLevel === 'error' || rawLevel === 'warn' || rawLevel === 'info' || rawLevel === 'debug' || rawLevel === 'trace'
      ? rawLevel
      : 'info';
  const logger = createStderrLogger(level);
  const server = new McpStdioServer(logger);

  process.stdin.setEncoding('utf8');

  let buffer = '';
  const inFlight = new Set<Promise<void>>();

  const handle = (line: string): void => {
    const work = server
      .handleLine(line)
      .catch((err) => {
        const e = err as unknown;
        logger.error('Unhandled request error', { message: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        inFlight.delete(work);
      });

    inFlight.add(work);
  };

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      handle(line);
    }
  });

  process.stdin.on('end', () => {
    if (buffer.trim().length > 0) {
      handle(buffer.trim());
      buffer = '';
    }
    void Promise.allSettled(Array.from(inFlight)).then(() => {
      process.exit(0);
    });
  });

  process.stdin.resume();
}

void main();
