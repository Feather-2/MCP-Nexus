import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { McpServiceConfig, McpMessage } from '../../types/index.js';

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
              security: (t as any).security || { trustLevel: 'trusted' },
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
      const { toolId } = request.params as { toolId: string };

      try {
        const template = await this.ctx.serviceRegistry.getTemplate(toolId as any);
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
              security: (template as any).security || { trustLevel: 'trusted' },
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
        body = ToolExecuteBodySchema.parse((request.body as any) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', {
          code: 'BAD_REQUEST',
          recoverable: true,
          meta: err.errors
        });
      }

      const { toolId, params, options } = body;
      const startTime = Date.now();
      const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        const result = await this.executeToolWithRetry(toolId, params, options);
        const durationMs = Date.now() - startTime;

        // Record execution
        this.recordExecution({
          id: execId,
          toolId,
          params,
          success: true,
          durationMs,
          result,
          timestamp: new Date()
        });

        reply.send({
          success: true,
          executionId: execId,
          result,
          durationMs
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const message = (error as any)?.message || 'Failed to execute tool';

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
        body = BatchExecuteBodySchema.parse((request.body as any) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', {
          code: 'BAD_REQUEST',
          recoverable: true,
          meta: err.errors
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
            } catch (e) {
              return {
                toolId: call.toolId,
                success: false,
                error: (e as any)?.message || 'Execution failed',
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
            } catch (e) {
              const errResult = {
                toolId: call.toolId,
                success: false,
                error: (e as any)?.message || 'Execution failed',
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
        const message = (error as any)?.message || 'Batch execution failed';
        return this.respondError(reply, 500, message, {
          code: 'BATCH_EXECUTE_FAILED',
          meta: { batchId }
        });
      }
    });

    // 获取执行历史
    server.get('/api/tools/history', async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { limit?: string; toolId?: string };
      const limit = Math.min(parseInt(query.limit || '20', 10), 100);
      const toolIdFilter = query.toolId;

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
    try {
      const adapter = await this.ctx.protocolAdapters.createAdapter(template as any);
      await adapter.connect();
      try {
        const msg: McpMessage = {
          jsonrpc: '2.0',
          id: `info-${Date.now()}`,
          method: 'tools/list',
          params: {}
        };
        const res = (adapter as any).sendAndReceive
          ? await (adapter as any).sendAndReceive(msg)
          : await adapter.send(msg);

        const tools = (res as any)?.result?.tools || [];
        const firstTool = tools[0];
        return {
          description: firstTool?.description,
          inputSchema: firstTool?.inputSchema,
          tools,
          toolCount: tools.length
        };
      } finally {
        await adapter.disconnect();
      }
    } catch {
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
        const template = await this.ctx.serviceRegistry.getTemplate(toolId as any);
        if (!template) {
          throw new Error(`Tool not found: ${toolId}`);
        }

        const adapter = await this.ctx.protocolAdapters.createAdapter(template as any);
        await adapter.connect();

        try {
          const msg: McpMessage = {
            jsonrpc: '2.0',
            id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            method: 'tools/call',
            params: {
              name: toolId,
              arguments: params || {}
            }
          };

          // Execute with timeout
          const execPromise = (adapter as any).sendAndReceive
            ? (adapter as any).sendAndReceive(msg)
            : adapter.send(msg);

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs)
          );

          const res = await Promise.race([execPromise, timeoutPromise]) as any;

          if (res?.error) {
            throw new Error(res.error.message || 'Tool execution error');
          }

          return res?.result ?? res;
        } finally {
          await adapter.disconnect();
        }
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }

    throw lastError || new Error('Tool execution failed after retries');
  }

  /**
   * Record execution to history
   */
  private recordExecution(record: ExecutionRecord): void {
    this.executionHistory.push(record);
    if (this.executionHistory.length > ToolRoutes.MAX_HISTORY_SIZE) {
      this.executionHistory.shift();
    }
  }
}

