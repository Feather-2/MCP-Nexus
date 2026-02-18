import os from 'os';
import path from 'path';
import type { GatewayConfig, Logger, McpServiceConfig } from '../types/index.js';
import { applyGatewaySandboxPolicy } from '../security/SandboxPolicy.js';
import { AuditPipeline, type AiAnalyzer, type AuditResult as SecurityAuditResult, type BehaviorAnalyzer } from '../security/AuditPipeline.js';
import type { AiAuditResult } from '../security/AiAuditor.js';
import type { AuditDecomposer } from '../security/AuditDecomposer.js';
import type { AuditSkillRouter } from '../security/AuditSkillRouter.js';
import { setupCanaries, checkCanaryAccess } from '../security/CanarySystem.js';
import { HardRuleEngine } from '../security/HardRuleEngine.js';
import { RiskScorer } from '../security/RiskScorer.js';
import { EntropyAnalyzer } from '../security/analyzers/EntropyAnalyzer.js';
import { PermissionAnalyzer } from '../security/analyzers/PermissionAnalyzer.js';
import type { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import { sendRequest } from '../adapters/ProtocolAdaptersImpl.js';
import type { EventBus } from '../events/bus.js';
import type { AuditResult, Skill } from './types.js';

export interface TemplateProvider {
  getTemplate(name: string): Promise<McpServiceConfig | null>;
}

export interface SkillAuditorOptions {
  logger?: Logger;
  getGatewayConfig: () => GatewayConfig;
  templates: TemplateProvider;
  protocolAdapters?: ProtocolAdaptersImpl;
  auditPipeline?: AuditPipeline;
  aiAuditor?: AiAnalyzer;
  behaviorAnalyzer?: BehaviorAnalyzer;
  decomposer?: AuditDecomposer;
  auditRouter?: AuditSkillRouter;
  eventBus?: EventBus;
}

type TrustLevel = 'trusted' | 'partner' | 'untrusted';

function parseAllowedTools(spec?: string): string[] {
  if (!spec) return [];
  return spec
    .split(/[, \n\r\t]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeTrustLevel(value: unknown): TrustLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'trusted' || normalized === 'partner' || normalized === 'untrusted') {
    return normalized;
  }
  return null;
}

function inferSkillTrustLevel(skill: Skill): TrustLevel {
  const tags = skill.metadata.tags || {};
  const explicit =
    normalizeTrustLevel(tags['trustLevel']) ??
    normalizeTrustLevel(tags['trust-level']) ??
    normalizeTrustLevel(tags['trust']) ??
    normalizeTrustLevel(tags['security.trustLevel']);
  if (explicit) return explicit;
  if ((skill.metadata.traits || []).map((t) => String(t).toLowerCase()).includes('untrusted')) {
    return 'untrusted';
  }
  return 'trusted';
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

function wrapAiAnalyzerWithEvents(analyzer: AiAnalyzer, eventBus: EventBus): AiAnalyzer {
  return {
    async auditSkill(skill: Skill): Promise<AiAuditResult> {
      const t0 = Date.now();
      try {
        const result = await analyzer.auditSkill(skill);
        eventBus.publish({
          type: 'aiauditor:llm:call',
          component: 'AiAuditor',
          payload: { operation: 'auditSkill', durationMs: Date.now() - t0, success: true }
        });
        return result;
      } catch (error) {
        eventBus.publish({
          type: 'aiauditor:llm:call',
          component: 'AiAuditor',
          payload: {
            operation: 'auditSkill',
            durationMs: Date.now() - t0,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  };
}

export class SkillAuditor {
  private readonly pipeline: AuditPipeline;

  constructor(private opts: SkillAuditorOptions) {
    const aiAuditor = opts.aiAuditor && opts.eventBus
      ? wrapAiAnalyzerWithEvents(opts.aiAuditor, opts.eventBus)
      : opts.aiAuditor;
    this.pipeline =
      opts.auditPipeline ??
      new AuditPipeline({
        hardRuleEngine: new HardRuleEngine(),
        entropyAnalyzer: new EntropyAnalyzer(),
        permissionAnalyzer: new PermissionAnalyzer(),
        riskScorer: new RiskScorer(),
        aiAuditor,
        behaviorAnalyzer: opts.behaviorAnalyzer,
        decomposer: opts.decomposer,
        auditRouter: opts.auditRouter
      });
  }

  async auditSecurity(skill: Skill): Promise<SecurityAuditResult> {
    return this.pipeline.audit(skill);
  }

  async auditSkill(skill: Skill, options?: { dryRun?: boolean; timeoutMsPerTool?: number }): Promise<AuditResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const gatewayConfig = this.opts.getGatewayConfig();
    this.auditIsolation(skill, gatewayConfig, warnings);

    const tools = parseAllowedTools(skill.metadata.allowedTools);
    const skills = (gatewayConfig as Record<string, unknown>)?.skills as Record<string, unknown> | undefined;
    const whitelist: string[] | undefined = Array.isArray(skills?.allowedTools)
      ? (skills.allowedTools as unknown[]).map((t) => String(t))
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

      const trustLevel = template.security?.trustLevel || 'trusted';
      const sandboxCfg = ((gatewayConfig as Record<string, unknown>)?.sandbox || {}) as Record<string, unknown>;
      const containerCfg = (sandboxCfg?.container || {}) as Record<string, unknown>;
      const enforced = sandboxCfg?.profile === 'locked-down' || containerCfg?.requiredForUntrusted === true;
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
      } catch (error: unknown) {
        errors.push(`Tool '${toolId}' violates sandbox policy: ${(error as Error)?.message || String(error)}`);
      }
    }

    const result: AuditResult = { passed: errors.length === 0, errors, warnings };

    try {
      result.security = await this.auditSecurity(skill);
    } catch (error: unknown) {
      warnings.push(`Security audit failed: ${(error as Error)?.message || String(error)}`);
    }

    const dryRun = Boolean(options?.dryRun);
    if (!dryRun || !result.passed) return result;
    if (!this.opts.protocolAdapters) {
      result.warnings.push('Dry-run skipped: protocolAdapters not available');
      return result;
    }

    const timeoutMs = options?.timeoutMsPerTool ?? 12_000;
    // Set up canary files in a temporary sandbox directory
    const canarySandboxRoot = path.join(os.tmpdir(), `pb-canary-${Date.now()}`);
    let canarySetup: Awaited<ReturnType<typeof setupCanaries>> | undefined;
    try {
      canarySetup = await setupCanaries(canarySandboxRoot);
    } catch (error: unknown) {
      result.warnings.push(`Canary setup failed: ${(error as Error)?.message || String(error)}`);
    }

    const dryRunResults: AuditResult['dryRunResults'] = [];

    for (const toolId of tools) {
      const template = await this.opts.templates.getTemplate(toolId);
      if (!template) continue;

      const start = Date.now();
      try {
        const { config } = applyGatewaySandboxPolicy(template, gatewayConfig);
        await withTimeout(
          this.opts.protocolAdapters.withAdapter(config, async (adapter) => {
            const msg: import('../types/index.js').McpMessage = { jsonrpc: '2.0', id: `dryrun-${Date.now()}`, method: 'tools/list', params: {} };
            const res = await sendRequest(adapter, msg);
            const ok = Boolean((res as Record<string, unknown>)?.result);
            dryRunResults.push({ tool: toolId, success: ok, latency: Date.now() - start });
          }),
          timeoutMs,
          `dryrun(${toolId})`
        );
      } catch (error: unknown) {
        dryRunResults.push({
          tool: toolId,
          success: false,
          latency: Date.now() - start,
          error: (error as Error)?.message || String(error)
        });
      }
    }

    // Check canary files for unauthorized access
    if (canarySetup) {
      try {
        const canaryResult = await checkCanaryAccess(canarySandboxRoot);
        if (canaryResult.triggered) {
          result.warnings.push(
            `Canary files accessed during dry-run: ${canaryResult.accessedFiles.join(', ')}`
          );
        }
      } catch (error: unknown) {
        result.warnings.push(`Canary check failed: ${(error as Error)?.message || String(error)}`);
      }
    }

    result.dryRunResults = dryRunResults;
    return result;
  }

  private auditIsolation(skill: Skill, gatewayConfig: GatewayConfig, warnings: string[]): void {
    const trustLevel = inferSkillTrustLevel(skill);
    if (trustLevel !== 'untrusted') return;

    const sandboxCfg = ((gatewayConfig as Record<string, unknown>)?.sandbox || {}) as Record<string, unknown>;
    const containerCfg = (sandboxCfg?.container || {}) as Record<string, unknown>;
    const enforced = sandboxCfg?.profile === 'locked-down' || containerCfg?.requiredForUntrusted === true;
    if (enforced) return;

    const warning = `Skill '${skill.metadata.name}' trustLevel=untrusted but container sandbox is not enforced`;
    warnings.push(warning);
    this.opts.logger?.warn?.('Skill isolation configuration is insufficient', {
      skill: skill.metadata.name,
      trustLevel,
      sandboxProfile: sandboxCfg?.profile,
      requiredForUntrusted: containerCfg?.requiredForUntrusted
    });
  }
}
