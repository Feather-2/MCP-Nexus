#!/usr/bin/env node
import { z } from 'zod';
import path from 'path';
import { MCP_VERSIONS } from './types/index.js';
import type { Logger, McpVersion } from './types/index.js';
import { TierRouter } from './routing/tier-router.js';
import { SkillRegistry } from './skills/SkillRegistry.js';
import { SkillMatcher } from './skills/SkillMatcher.js';
import { SkillVersionStore } from './skills/SkillVersionStore.js';

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

const ListSkillsArgsSchema = z.object({
  query: z.string().optional(),
  scope: z.enum(['repo', 'user', 'system', 'remote']).optional()
});

const MatchSkillArgsSchema = z.object({
  input: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional()
});

const AuditSkillArgsSchema = z.object({
  name: z.string().min(1)
});

const GetVersionsArgsSchema = z.object({
  name: z.string().min(1)
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

class McpStdioServer {
  private readonly logger: Logger;
  private readonly tierRouter = new TierRouter();
  private readonly registry: SkillRegistry;
  private readonly matcher: SkillMatcher;
  private readonly versionStore: SkillVersionStore;
  private readonly initPromise: Promise<void>;
  private readonly tools: StdioToolDefinition[];

  constructor(logger: Logger) {
    this.logger = logger;
    this.registry = new SkillRegistry({ logger: this.logger });
    this.matcher = new SkillMatcher();
    this.versionStore = new SkillVersionStore({
      storageRoot: path.resolve(process.cwd(), 'data'),
      logger: this.logger
    });
    this.initPromise = this.registry.reload().catch((e) => {
      this.logger.warn('Skills registry reload failed', {
        error: e instanceof Error ? e.message : String(e)
      });
    });

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
        name: 'list_skills',
        description: 'List all registered skills with metadata',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optional search query' },
            scope: {
              type: 'string',
              enum: ['repo', 'user', 'system', 'remote'],
              description: 'Filter by scope'
            }
          }
        }
      },
      {
        name: 'match_skill',
        description: 'Find best matching skill for input',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input text to match' },
            maxResults: { type: 'number', description: 'Max results (default 5)' }
          },
          required: ['input']
        }
      },
      {
        name: 'audit_skill',
        description: 'Run security audit on a registered skill',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name' }
          },
          required: ['name']
        }
      },
      {
        name: 'get_versions',
        description: 'List version snapshots for a skill',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name' }
          },
          required: ['name']
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

    if (toolName === 'list_skills') {
      const argsParsed = ListSkillsArgsSchema.safeParse(args);
      if (!argsParsed.success) {
        throw new JsonRpcDispatchError(-32602, 'Invalid params', argsParsed.error.flatten());
      }

      await this.initPromise;
      const query = argsParsed.data.query?.trim().toLowerCase();
      const scope = argsParsed.data.scope;

      let skills = this.registry.list();
      if (scope) {
        skills = skills.filter((skill) => skill.scope === scope);
      }
      if (query) {
        const tokens = query.split(/\s+/).filter(Boolean);
        skills = skills.filter((skill) => {
          const haystack = `${skill.name} ${skill.description} ${skill.shortDescription || ''}`.toLowerCase();
          if (haystack.includes(query)) return true;
          return tokens.some((token) => skill.keywordsAll.some((keyword) => keyword.toLowerCase().includes(token)));
        });
      }

      return toTextResult({ skills });
    }

    if (toolName === 'match_skill') {
      const argsParsed = MatchSkillArgsSchema.safeParse(args);
      if (!argsParsed.success) {
        throw new JsonRpcDispatchError(-32602, 'Invalid params', argsParsed.error.flatten());
      }

      await this.initPromise;
      const index = this.matcher.buildIndex(this.registry.all());
      const matches = this.matcher.match(argsParsed.data.input, index, {
        maxResults: argsParsed.data.maxResults
      });

      return toTextResult({
        matches: matches.map((match) => ({
          metadata: match.skill.metadata,
          ...match.result
        }))
      });
    }

    if (toolName === 'audit_skill') {
      const argsParsed = AuditSkillArgsSchema.safeParse(args);
      if (!argsParsed.success) {
        throw new JsonRpcDispatchError(-32602, 'Invalid params', argsParsed.error.flatten());
      }

      await this.initPromise;
      const skill = this.registry.get(argsParsed.data.name);
      if (!skill) {
        throw new JsonRpcDispatchError(-32602, `Skill not found: ${argsParsed.data.name}`);
      }

      const [{ AuditPipeline }, { HardRuleEngine }, { RiskScorer }, { EntropyAnalyzer }, { PermissionAnalyzer }] =
        await Promise.all([
          import('./security/AuditPipeline.js'),
          import('./security/HardRuleEngine.js'),
          import('./security/RiskScorer.js'),
          import('./security/analyzers/EntropyAnalyzer.js'),
          import('./security/analyzers/PermissionAnalyzer.js')
        ]);

      const pipeline = new AuditPipeline({
        hardRuleEngine: new HardRuleEngine(),
        entropyAnalyzer: new EntropyAnalyzer(),
        permissionAnalyzer: new PermissionAnalyzer(),
        riskScorer: new RiskScorer()
      });

      const result = pipeline.auditSync(skill);
      return toTextResult({ result });
    }

    if (toolName === 'get_versions') {
      const argsParsed = GetVersionsArgsSchema.safeParse(args);
      if (!argsParsed.success) {
        throw new JsonRpcDispatchError(-32602, 'Invalid params', argsParsed.error.flatten());
      }

      const versions = await this.versionStore.list(argsParsed.data.name);
      return toTextResult({ versions });
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
