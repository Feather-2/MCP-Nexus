import type { GatewayConfig, Logger, McpServiceConfig } from '../types/index.js';
import { applyGatewaySandboxPolicy } from '../security/SandboxPolicy.js';
import type { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import type { AuditResult, Skill } from './types.js';

export interface TemplateProvider {
  getTemplate(name: string): Promise<McpServiceConfig | null>;
}

export interface SkillAuditorOptions {
  logger?: Logger;
  getGatewayConfig: () => GatewayConfig;
  templates: TemplateProvider;
  protocolAdapters?: ProtocolAdaptersImpl;
}

function parseAllowedTools(spec?: string): string[] {
  if (!spec) return [];
  return spec
    .split(/[, \n\r\t]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = new Promise<T>((_resolve, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

export class SkillAuditor {
  constructor(private opts: SkillAuditorOptions) {}

  async auditSkill(skill: Skill, options?: { dryRun?: boolean; timeoutMsPerTool?: number }): Promise<AuditResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const gatewayConfig = this.opts.getGatewayConfig();
    const tools = parseAllowedTools(skill.metadata.allowedTools);
    const whitelist: string[] | undefined = Array.isArray((gatewayConfig as any)?.skills?.allowedTools)
      ? ((gatewayConfig as any).skills.allowedTools as any[]).map((t: any) => String(t))
      : undefined;

    for (const toolId of tools) {
      if (whitelist && whitelist.length > 0 && !whitelist.includes(toolId)) {
        errors.push(`Tool '${toolId}' not allowed by gateway.skills.allowedTools whitelist`);
        continue;
      }
      const template = await this.opts.templates.getTemplate(toolId);
      if (!template) {
        errors.push(`Tool '${toolId}' not found in templates`);
        continue;
      }

      const trustLevel = (template as any)?.security?.trustLevel || 'trusted';
      const sandboxCfg: any = (gatewayConfig as any)?.sandbox || {};
      const enforced = sandboxCfg?.profile === 'locked-down' || sandboxCfg?.container?.requiredForUntrusted === true;
      if (trustLevel !== 'trusted' && !enforced) {
        warnings.push(
          `Tool '${toolId}' trustLevel=${trustLevel} but sandbox.container.requiredForUntrusted is disabled`
        );
      }

      try {
        const outcome = applyGatewaySandboxPolicy(template, gatewayConfig);
        if (outcome.applied) {
          warnings.push(`Tool '${toolId}' sandbox policy applied (${outcome.reasons.join(', ')})`);
        }
      } catch (e: any) {
        errors.push(`Tool '${toolId}' violates sandbox policy: ${e?.message || String(e)}`);
      }
    }

    const result: AuditResult = { passed: errors.length === 0, errors, warnings };

    const dryRun = Boolean(options?.dryRun);
    if (!dryRun || !result.passed) return result;
    if (!this.opts.protocolAdapters) {
      result.warnings.push('Dry-run skipped: protocolAdapters not available');
      return result;
    }

    const timeoutMs = options?.timeoutMsPerTool ?? 12_000;
    const dryRunResults: AuditResult['dryRunResults'] = [];

    for (const toolId of tools) {
      const template = await this.opts.templates.getTemplate(toolId);
      if (!template) continue;

      const start = Date.now();
      try {
        const { config } = applyGatewaySandboxPolicy(template, gatewayConfig);
        const adapter = await this.opts.protocolAdapters.createAdapter(config as any);
        await withTimeout(adapter.connect(), timeoutMs, `connect(${toolId})`);
        try {
          const msg: any = { jsonrpc: '2.0', id: `dryrun-${Date.now()}`, method: 'tools/list', params: {} };
          const res = await withTimeout(
            ((adapter as any).sendAndReceive?.(msg) ?? adapter.send(msg)),
            timeoutMs,
            `tools/list(${toolId})`
          );
          const ok = Boolean((res as any)?.result);
          dryRunResults.push({ tool: toolId, success: ok, latency: Date.now() - start });
        } finally {
          await withTimeout(adapter.disconnect(), timeoutMs, `disconnect(${toolId})`).catch(() => {});
        }
      } catch (e: any) {
        dryRunResults.push({
          tool: toolId,
          success: false,
          latency: Date.now() - start,
          error: e?.message || String(e)
        });
      }
    }

    result.dryRunResults = dryRunResults;
    return result;
  }
}
