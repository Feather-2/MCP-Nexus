import { Logger, McpMessage, McpServiceConfig, OrchestratorConfig } from '../types/index.js';
import { ServiceRegistryImpl } from '../gateway/ServiceRegistryImpl.js';
import { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import { OrchestratorManager } from './OrchestratorManager.js';
import { SubagentLoader } from './SubagentLoader.js';
import type { ExecuteRequest, ExecuteResult, OrchestratorStep } from './types.js';
import { SubagentScheduler } from './SubagentScheduler.js';
import { LocalPlanner } from './planning/LocalPlanner.js';
import type { EventBus } from '../events/bus.js';

export type { OrchestratorStep, ExecuteRequest, ExecuteResult } from './types.js';

// 编排生命周期事件类型
export const OrchestratorEvents = {
  EXECUTE_START: 'orchestrator:execute:start',
  EXECUTE_END: 'orchestrator:execute:end',
  EXECUTE_ERROR: 'orchestrator:execute:error',
  PLAN_START: 'orchestrator:plan:start',
  PLAN_END: 'orchestrator:plan:end',
  STEP_START: 'orchestrator:step:start',
  STEP_END: 'orchestrator:step:end',
  STEP_ERROR: 'orchestrator:step:error',
} as const;

export class OrchestratorEngine {
  private logger: Logger;
  private registry: ServiceRegistryImpl;
  private adapters: ProtocolAdaptersImpl;
  private orchestrator: OrchestratorManager;
  private subagents: SubagentLoader;
  private eventBus?: EventBus;

  constructor(opts: { logger: Logger; serviceRegistry: ServiceRegistryImpl; protocolAdapters: ProtocolAdaptersImpl; orchestratorManager: OrchestratorManager; subagentLoader: SubagentLoader; eventBus?: EventBus; }) {
    this.logger = opts.logger;
    this.registry = opts.serviceRegistry;
    this.adapters = opts.protocolAdapters;
    this.orchestrator = opts.orchestratorManager;
    this.subagents = opts.subagentLoader;
    this.eventBus = opts.eventBus;
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = Date.now();
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const config = this.orchestrator.getConfig() as OrchestratorConfig;
    const maxSteps = req.maxSteps ?? config.planner?.maxSteps ?? 8;
    const timeoutMs = req.timeoutMs ?? config.budget?.maxTimeMs ?? 300_000;

    this.emit(OrchestratorEvents.EXECUTE_START, runId, {
      goal: req.goal,
      stepsProvided: req.steps?.length ?? 0,
      parallel: req.parallel,
      maxSteps,
      timeoutMs
    });

    // Best-effort: keep subagent cache warm for planning/template selection.
    try { await this.subagents.loadAll(); } catch (e) { this.logger.warn('Failed to load subagents', { error: (e as Error).message }); }

    this.emit(OrchestratorEvents.PLAN_START, runId, { goal: req.goal });
    const plan = await this.buildPlan(req.goal, req.steps, config);
    const finalPlan = plan.slice(0, Math.max(1, Math.min(plan.length, maxSteps)));
    this.emit(OrchestratorEvents.PLAN_END, runId, { planSize: finalPlan.length });

    const concurrency = {
      global: config.budget?.concurrency?.global ?? 8,
      perSubagent: config.budget?.concurrency?.perSubagent ?? 2
    };
    const scheduler = new SubagentScheduler(this.logger, {
      concurrency,
      defaultStepTimeoutMs: Math.min(30_000, timeoutMs),
      overallTimeoutMs: timeoutMs,
      eventBus: this.eventBus
    });

    let scheduled;
    try {
      scheduled = await scheduler.run(finalPlan, (s) => this.runStepWithEvents(s, runId), { parallel: req.parallel });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.emit(OrchestratorEvents.EXECUTE_ERROR, runId, {
        error: error instanceof Error ? error.message : String(error),
        stepsCompleted: 0,
        durationMs
      });
      throw error;
    }
    const results: ExecuteResult['results'] = scheduled.map((r) => ({
      step: r.step,
      ok: r.ok,
      response: r.response,
      error: r.error,
      durationMs: r.durationMs
    }));

    const success = results.every(r => r.ok);
    const durationMs = Date.now() - startedAt;

    this.emit(OrchestratorEvents.EXECUTE_END, runId, {
      success,
      stepsExecuted: results.length,
      stepsFailed: results.filter(r => !r.ok).length,
      durationMs
    });

    return {
      success,
      plan: finalPlan,
      results,
      used: { steps: results.length, durationMs }
    };
  }

  private async buildPlan(goal?: string, provided?: OrchestratorStep[], config?: OrchestratorConfig): Promise<OrchestratorStep[]> {
    if (provided && provided.length > 0) return provided;
    if (!goal) return [];

    // Local planner (gap-driven scaffold) by default.
    // Remote planning can be added later via config.planner.provider === 'remote'.
    let templates: McpServiceConfig[] = [];
    try {
      templates = await this.registry.listTemplates();
    } catch {
      templates = [];
    }
    const subs = this.subagents.list();
    const planner = new LocalPlanner();
    const planned = planner.plan(goal, { subagents: subs, templates });

    // If user explicitly configured remote planner, keep the hook (fallback to local for now).
    if (config?.planner?.provider === 'remote') {
      this.logger.warn('planner.provider=remote is not configured; falling back to local planner');
    }

    return planned.plan;
  }

  private async runStepWithEvents(step: OrchestratorStep, runId: string): Promise<unknown> {
    const stepId = step.subagent || step.template || 'unknown';
    this.emit(OrchestratorEvents.STEP_START, runId, {
      stepId,
      template: step.template,
      subagent: step.subagent,
      tool: step.tool
    });

    const t0 = Date.now();
    try {
      const result = await this.runStep(step);
      this.emit(OrchestratorEvents.STEP_END, runId, {
        stepId,
        durationMs: Date.now() - t0
      });
      return result;
    } catch (error) {
      this.emit(OrchestratorEvents.STEP_ERROR, runId, {
        stepId,
        durationMs: Date.now() - t0,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async runStep(step: OrchestratorStep): Promise<unknown> {
    const templateName = step.template || this.selectTemplate(step);
    if (!templateName) throw new Error('No suitable template found for step');

    const template = await this.registry.getTemplate(templateName);
    if (!template) throw new Error(`Template not found: ${templateName}`);

    const adapter = await this.adapters.createAdapter(template as McpServiceConfig);
    try {
      await adapter.connect();
      const toolName = await this.resolveToolName(adapter, step.tool);
      const msg: McpMessage = {
        jsonrpc: '2.0',
        id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: 'tools/call',
        params: { name: toolName, arguments: step.params || {} }
      };
      const res = await this.sendAndReceive(adapter, msg);
      return (res as unknown as Record<string, unknown>)?.result ?? res;
    } finally {
      this.adapters.releaseAdapter(template as McpServiceConfig, adapter);
    }
  }

  private async resolveToolName(adapter: { sendAndReceive?: (msg: McpMessage) => Promise<McpMessage>; send: (msg: McpMessage) => Promise<void>; receive: () => Promise<McpMessage> }, requested?: string): Promise<string> {
    const listMsg: McpMessage = {
      jsonrpc: '2.0',
      id: `tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: 'tools/list',
      params: {}
    };
    const res = await this.sendAndReceive(adapter, listMsg).catch(() => undefined);
    const r = res as Record<string, unknown> | undefined;
    const result = r?.result as Record<string, unknown> | undefined;
    const tools = result?.tools;
    const names: string[] = Array.isArray(tools) ? tools.map((t) => String((t as Record<string, unknown>)?.name || '')).filter(Boolean) : [];

    if (!requested) {
      return names[0] || 'search';
    }

    if (names.includes(requested)) return requested;
    const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '_');
    const target = norm(requested);
    const hit = names.find((n) => norm(n) === target);
    if (hit) return hit;
    // Fall back to requested to preserve backward compatibility for servers that don't support tools/list properly.
    return requested;
  }

  private async sendAndReceive(adapter: { sendAndReceive?: (msg: McpMessage) => Promise<McpMessage>; send: (msg: McpMessage) => Promise<void>; receive: () => Promise<McpMessage> }, message: McpMessage): Promise<McpMessage> {
    if (typeof adapter?.sendAndReceive === 'function') {
      return adapter.sendAndReceive(message);
    }
    await adapter.send(message);
    return adapter.receive();
  }

  private selectTemplate(step: OrchestratorStep): string | null {
    // 优先按 subagent.tools 指明的具体模板名；其次按子代理名；最后内置映射
    const sub = step.subagent ? this.subagents.get(step.subagent) : undefined;
    const preferredTool = step.tool || 'search';
    if (sub && Array.isArray(sub.tools) && sub.tools.length > 0) {
      // 若 tools 中包含已知模板名，直接选第一个
      const direct = sub.tools.find(t => typeof t === 'string');
      if (direct) return direct;
    }
    // 常见内置映射
    if ((step.subagent || '').toLowerCase() === 'search' || preferredTool === 'search') return 'brave-search';
    if ((step.subagent || '').toLowerCase() === 'filesystem') return 'filesystem';
    return null;
  }

  private emit(type: string, runId: string, payload: Record<string, unknown>): void {
    if (!this.eventBus) return;
    this.eventBus.publish({
      type,
      runId,
      stage: 'orchestrator',
      component: 'OrchestratorEngine',
      payload
    });
  }
}
