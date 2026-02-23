import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { McpServiceConfig } from '../../types/index.js';
import { MiddlewareChain } from '../../middleware/chain.js';
import { sleepBackoff } from '../../utils/async.js';
import { sendRequest } from '../../adapters/ProtocolAdaptersImpl.js';
import { mcpRequest } from '../../core/mcpMessage.js';

// Schema definitions
const ToolExecuteBodySchema = z.object({
  toolId: z.string().min(1),
  params: z.unknown().optional(),
  options: z.object({
    timeoutMs: z.number().int().positive().max(300000).optional(),
    retries: z.number().int().min(0).max(5).optional()
  }).optional()
});

const BatchExecuteBodySchema = z.object({
  calls: z.array(z.object({
    toolId: z.string().min(1),
    params: z.unknown().optional()
  })).min(1).max(10),
  options: z.object({
    parallel: z.boolean().optional(),
    stopOnError: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(300000).optional()
  }).optional()
});

type ToolExecuteBody = z.infer<typeof ToolExecuteBodySchema>;
type BatchExecuteBody = z.infer<typeof BatchExecuteBodySchema>;

// Execution history entry (in-memory, limited)
interface ExecutionRecord {
  id: string;
  toolId: string;
  params: unknown;
  success: boolean;
  durationMs: number;
  result?: unknown;
  error?: string;
  timestamp: Date;
}

/**
 * Tool API routes
 *
 * Endpoints:
 * - GET  /api/tools              列出所有可用工具（聚合模板和 MCP 工具）
 * - GET  /api/tools/:toolId      获取单个工具详情（含 inputSchema）
 * - POST /api/tools/execute      执行单个工具
 * - POST /api/tools/batch        批量执行多个工具
 * - GET  /api/tools/history      获取最近执行历史
 *
 * v1: 增强实现，支持工具聚合、批量执行和执行历史
 */
export class ToolRoutes extends BaseRouteHandler {
  private static readonly MAX_HISTORY_SIZE = 100;
  private executionHistory: ExecutionRecord[] = [];

  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // 列出所有可用工具（聚合视图）
    server.get('/api/tools', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const templates = await this.ctx.configManager.listTemplates();
        const tools = await Promise.all(templates.map(async (t) => {
          const toolInfo = await this.fetchToolInfo(t as McpServiceConfig);
          return {
            id: t.name,
            name: t.name,
            description: toolInfo.description || `MCP service: ${t.name}`,
            inputSchema: toolInfo.inputSchema,
            meta: {
              transport: t.transport,
              version: t.version,
              security: t.security || { trustLevel: 'trusted' },
              toolCount: toolInfo.toolCount
            }
          };
        }));
        reply.send({ success: true, tools });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list tools';
        return this.respondError(reply, 500, message, { code: 'TOOLS_LIST_FAILED' });
      }
    });

    // 获取单个工具详情
    server.get('/api/tools/:toolId', async (request: FastifyRequest, reply: FastifyReply) => {
      const ToolIdParam = z.object({ toolId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._\-]+$/) });
      const parsed = ToolIdParam.safeParse(request.params);
      if (!parsed.success) return this.respondError(reply, 400, 'Invalid toolId', { code: 'BAD_REQUEST', recoverable: true, meta: parsed.error.issues });
      const { toolId } = parsed.data;

      try {
        const template = await this.ctx.serviceRegistry.getTemplate(toolId);
        if (!template) {
          return this.respondError(reply, 404, `Tool not found: ${toolId}`, {
            code: 'TOOL_NOT_FOUND',
            recoverable: true
          });
        }

        const toolInfo = await this.fetchToolInfo(template);
        reply.send({
          success: true,
          tool: {
            id: template.name,
            name: template.name,
            description: toolInfo.description || `MCP service: ${template.name}`,
            inputSchema: toolInfo.inputSchema,
            availableTools: toolInfo.tools,
            meta: {
              transport: template.transport,
              version: template.version,
              security: (template as Record<string, unknown>).security || { trustLevel: 'trusted' },
              healthCheck: template.healthCheck
            }
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get tool details';
        return this.respondError(reply, 500, message, { code: 'TOOL_GET_FAILED' });
      }
    });

    // 执行单个工具
    server.post('/api/tools/execute', async (request: FastifyRequest, reply: FastifyReply) => {
      let body: ToolExecuteBody;
      try {
        body = ToolExecuteBodySchema.parse((request.body as Record<string, unknown>) || {});
      } catch (error) {
        const zodErr = error as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', {
          code: 'BAD_REQUEST',
          recoverable: true,
          meta: zodErr.issues
        });
      }

      const { toolId, params, options } = body;
      const startTime = Date.now();
      const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Prepare Middleware Context & State
      const mwCtx = {
        requestId: execId,
        startTime,
        metadata: {},
        sessionId: ((request as unknown as Record<string, unknown>).auth as Record<string, unknown> | undefined)?.context as string | undefined
      };
      const mwState = {
        stage: 'beforeTool' as const,
        values: new Map<string, unknown>([
          ['toolCall', { name: toolId, arguments: params }],
          ['selectedInstanceId', toolId],
          ['toolStartTimeMs', startTime]
        ]),
        aborted: false
      };

      try {
        // Execute Middlewares (beforeTool)
        const chain = this.ctx.middlewareChain ?? new MiddlewareChain(this.ctx.middlewares || []);
        await chain.execute('beforeTool', mwCtx, mwState);

        const result = await this.executeToolWithRetry(toolId, params, options);
        
        // Execute Middlewares (afterTool)
        mwState.values.set('toolResult', { content: typeof result === 'string' ? result : JSON.stringify(result) });
        mwState.values.set('toolEndTimeMs', Date.now());
        await chain.execute('afterTool', mwCtx, mwState);

        const finalResult = (mwState.values.get('toolResult') as Record<string, unknown>)?.content;
        const durationMs = Date.now() - startTime;

        // Record execution
        this.recordExecution({
          id: execId,
          toolId,
          params,
          success: true,
          durationMs,
          result: finalResult,
          timestamp: new Date()
        });

        reply.send({
          success: true,
          executionId: execId,
          result: finalResult,
          durationMs
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const message = (error as Error)?.message || 'Failed to execute tool';
        const chain = this.ctx.middlewareChain ?? new MiddlewareChain(this.ctx.middlewares || []);
        mwState.values.set('toolError', message);
        mwState.values.set('toolEndTimeMs', Date.now());
        try { await chain.execute('afterTool', mwCtx, mwState); } catch { /* best-effort afterTool middleware */ }

        this.recordExecution({
          id: execId,
          toolId,
          params,
          success: false,
          durationMs,
          error: message,
          timestamp: new Date()
        });

        this.ctx.logger.error('Tool execute failed', { error: message, toolId, durationMs });
        return this.respondError(reply, 500, message, {
          code: 'TOOL_EXECUTE_FAILED',
          recoverable: false,
          meta: { executionId: execId, durationMs }
        });
      }
    });

    // 批量执行工具
    server.post('/api/tools/batch', async (request: FastifyRequest, reply: FastifyReply) => {
      let body: BatchExecuteBody;
      try {
        body = BatchExecuteBodySchema.parse((request.body as Record<string, unknown>) || {});
      } catch (error) {
        const zodErr = error as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', {
          code: 'BAD_REQUEST',
          recoverable: true,
          meta: zodErr.issues
        });
      }

      const { calls, options } = body;
      const parallel = options?.parallel ?? false;
      const stopOnError = options?.stopOnError ?? true;
      const startTime = Date.now();
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const results: Array<{
        toolId: string;
        success: boolean;
        result?: unknown;
        error?: string;
        durationMs: number;
      }> = [];

      try {
        if (parallel) {
          // Parallel execution
          const promises = calls.map(async (call) => {
            const callStart = Date.now();
            try {
              const result = await this.executeToolWithRetry(call.toolId, call.params, {
                timeoutMs: options?.timeoutMs
              });
              return { toolId: call.toolId, success: true, result, durationMs: Date.now() - callStart };
            } catch (error) {
              return {
                toolId: call.toolId,
                success: false,
                error: (error as Error)?.message || 'Execution failed',
                durationMs: Date.now() - callStart
              };
            }
          });
          results.push(...await Promise.all(promises));
        } else {
          // Sequential execution
          for (const call of calls) {
            const callStart = Date.now();
            try {
              const result = await this.executeToolWithRetry(call.toolId, call.params, {
                timeoutMs: options?.timeoutMs
              });
              results.push({ toolId: call.toolId, success: true, result, durationMs: Date.now() - callStart });
            } catch (error) {
              const errResult = {
                toolId: call.toolId,
                success: false,
                error: (error as Error)?.message || 'Execution failed',
                durationMs: Date.now() - callStart
              };
              results.push(errResult);
              if (stopOnError) break;
            }
          }
        }

        const totalDurationMs = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;

        reply.send({
          success: successCount === results.length,
          batchId,
          results,
          summary: {
            total: results.length,
            succeeded: successCount,
            failed: results.length - successCount,
            totalDurationMs
          }
        });
      } catch (error) {
        const message = (error as Error)?.message || 'Batch execution failed';
        return this.respondError(reply, 500, message, {
          code: 'BATCH_EXECUTE_FAILED',
          meta: { batchId }
        });
      }
    });

    // 获取执行历史
    server.get('/api/tools/history', async (request: FastifyRequest, reply: FastifyReply) => {
      const HistoryQuery = z.object({ limit: z.coerce.number().int().positive().max(100).optional().default(20), toolId: z.string().max(128).optional() });
      const parsed = HistoryQuery.safeParse(request.query);
      if (!parsed.success) return this.respondError(reply, 400, 'Invalid query', { code: 'BAD_REQUEST', recoverable: true, meta: parsed.error.issues });
      const { limit, toolId: toolIdFilter } = parsed.data;

      let history = [...this.executionHistory].reverse();
      if (toolIdFilter) {
        history = history.filter(h => h.toolId === toolIdFilter);
      }

      reply.send({
        success: true,
        history: history.slice(0, limit),
        total: history.length
      });
    });
  }

  /**
   * Fetch tool info from MCP service (tools/list)
   */
  private async fetchToolInfo(template: McpServiceConfig): Promise<{
    description?: string;
    inputSchema?: unknown;
    tools?: unknown[];
    toolCount: number;
  }> {
    // Check cache first
    const cached = this.ctx.toolListCache?.get(template.name);
    if (cached) {
      const tools = cached as Record<string, unknown>[];
      const firstTool = tools[0];
      return {
        description: firstTool?.description as string | undefined,
        inputSchema: firstTool?.inputSchema,
        tools,
        toolCount: tools.length
      };
    }

    try {
      return await this.ctx.protocolAdapters.withAdapter(template, async (adapter) => {
        const msg = mcpRequest('tools/list', {}, 'info');
        const res = await sendRequest(adapter, msg);

        const r = res as Record<string, unknown> | undefined;
        const tools = ((r?.result as Record<string, unknown>)?.tools as unknown[]) || [];

        // Cache the result
        this.ctx.toolListCache?.set(template.name, tools);

        const firstTool = tools[0] as Record<string, unknown> | undefined;
        return {
          description: firstTool?.description as string | undefined,
          inputSchema: firstTool?.inputSchema,
          tools,
          toolCount: tools.length
        };
      });
    } catch { /* best-effort: tool info fetch is non-critical */
      return { toolCount: 0 };
    }
  }

  /**
   * Execute tool with retry support
   */
  private async executeToolWithRetry(
    toolId: string,
    params: unknown,
    options?: { timeoutMs?: number; retries?: number }
  ): Promise<unknown> {
    const maxRetries = options?.retries ?? 2;
    const timeoutMs = options?.timeoutMs ?? 30000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const template = await this.ctx.serviceRegistry.getTemplate(toolId);
        if (!template) {
          throw new Error(`Tool not found: ${toolId}`);
        }

        return await this.ctx.protocolAdapters.withAdapter(template, async (adapter) => {
          const msg = mcpRequest('tools/call', { name: toolId, arguments: params || {} }, 'tool');

          // Execute with timeout
          const execPromise = sendRequest(adapter, msg);

          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs);
          });

          let res: Record<string, unknown> | undefined;
          try {
            res = await Promise.race([execPromise, timeoutPromise]) as Record<string, unknown> | undefined;
          } finally {
            clearTimeout(timeoutId!);
          }

          if (res?.error) {
            throw new Error((res.error as Record<string, unknown>)?.message as string || 'Tool execution error');
          }

          return res?.result ?? res;
        });
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          await sleepBackoff(attempt);
        }
      }
    }

    throw lastError || new Error('Tool execution failed after retries');
  }

  /**
   * Record execution to history
   */
  private static truncateForHistory(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    try {
      const json = JSON.stringify(value);
      if (json.length <= 4096) return value;
      return json.slice(0, 4096) + '...(truncated)';
    } catch {
      return '[unserializable]';
    }
  }

  private recordExecution(record: ExecutionRecord): void {
    this.executionHistory.push({
      ...record,
      params: ToolRoutes.truncateForHistory(record.params),
      result: ToolRoutes.truncateForHistory(record.result)
    });
    if (this.executionHistory.length > ToolRoutes.MAX_HISTORY_SIZE) {
      this.executionHistory.shift();
    }
  }
}
