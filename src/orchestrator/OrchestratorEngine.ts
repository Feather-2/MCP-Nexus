import { Logger, McpMessage, McpServiceConfig, OrchestratorConfig } from '../types/index.js';
import { ServiceRegistryImpl } from '../gateway/ServiceRegistryImpl.js';
import { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import { OrchestratorManager } from './OrchestratorManager.js';
import { SubagentLoader } from './SubagentLoader.js';

export interface OrchestratorStep {
  subagent?: string;
  tool?: string;
  params?: any;
}

export interface ExecuteRequest {
  goal?: string;
  steps?: OrchestratorStep[];
  parallel?: boolean;
  maxSteps?: number;
  timeoutMs?: number;
}

export interface ExecuteResult {
  success: boolean;
  plan: OrchestratorStep[];
  results: Array<{ step: OrchestratorStep; ok: boolean; response?: any; error?: string; durationMs: number }>;
  used: { steps: number; durationMs: number };
}

export class OrchestratorEngine {
  private logger: Logger;
  private registry: ServiceRegistryImpl;
  private adapters: ProtocolAdaptersImpl;
  private orchestrator: OrchestratorManager;
  private subagents: SubagentLoader;

  constructor(opts: { logger: Logger; serviceRegistry: ServiceRegistryImpl; protocolAdapters: ProtocolAdaptersImpl; orchestratorManager: OrchestratorManager; subagentLoader: SubagentLoader; }) {
    this.logger = opts.logger;
    this.registry = opts.serviceRegistry;
    this.adapters = opts.protocolAdapters;
    this.orchestrator = opts.orchestratorManager;
    this.subagents = opts.subagentLoader;
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = Date.now();
    const config = this.orchestrator.getConfig() as OrchestratorConfig;
    const maxSteps = req.maxSteps ?? config.planner?.maxSteps ?? 8;
    const timeoutMs = req.timeoutMs ?? config.budget?.maxTimeMs ?? 300_000;

    const plan = await this.buildPlan(req.goal, req.steps);
    const finalPlan = plan.slice(0, Math.max(1, Math.min(plan.length, maxSteps)));

    const results: ExecuteResult['results'] = [];

    for (const step of finalPlan) {
      if (Date.now() - startedAt > timeoutMs) {
        results.push({ step, ok: false, error: 'time budget exceeded', durationMs: 0 });
        break;
      }

      const t0 = Date.now();
      try {
        const response = await this.runStep(step);
        results.push({ step, ok: true, response, durationMs: Date.now() - t0 });
      } catch (err: any) {
        results.push({ step, ok: false, error: err?.message || String(err), durationMs: Date.now() - t0 });
      }
    }

    return {
      success: results.every(r => r.ok),
      plan: finalPlan,
      results,
      used: { steps: results.length, durationMs: Date.now() - startedAt }
    };
  }

  private async buildPlan(goal?: string, provided?: OrchestratorStep[]): Promise<OrchestratorStep[]> {
    if (provided && provided.length > 0) return provided;
    // Naive planner: if goal 存在则优先使用 search 子代理/工具
    // 映射顺序：subagent "search" → 工具 "search" → 模板 "brave-search"
    const plan: OrchestratorStep[] = [];
    const subs = this.subagents.list();
    const searchSub = subs.find(s => s.name === 'search' || (s.tools || []).includes('brave-search'));
    if (goal && searchSub) {
      plan.push({ subagent: searchSub.name, tool: 'search', params: { query: goal } });
    } else if (goal) {
      // fallback：直接调用 brave-search
      plan.push({ subagent: 'search', tool: 'search', params: { query: goal } });
    }
    return plan;
  }

  private async runStep(step: OrchestratorStep): Promise<any> {
    const templateName = this.selectTemplate(step);
    if (!templateName) throw new Error('No suitable template found for step');

    const template = await this.registry.getTemplate(templateName);
    if (!template) throw new Error(`Template not found: ${templateName}`);

    const adapter = await this.adapters.createAdapter(template as McpServiceConfig);
    await adapter.connect();
    try {
      const msg: McpMessage = {
        jsonrpc: '2.0',
        id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: 'tools/call',
        params: { name: step.tool || 'search', arguments: step.params || {} }
      };
      const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
      return res?.result ?? res;
    } finally {
      await adapter.disconnect();
    }
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
}

