import type { Skill } from '../skills/types.js';
import type { HardRuleEvaluation } from './HardRuleEngine.js';
import type { EntropyResult } from './analyzers/EntropyAnalyzer.js';
import type { PermissionAnalysisResult } from './analyzers/PermissionAnalyzer.js';
import type { AiAuditResult, AiFindingSeverity } from './AiAuditor.js';
import type { BehaviorValidationResult, ViolationSeverity } from './BehaviorValidator.js';
import type { RiskDecision, RiskSignal, SyncAuditResult, AsyncAuditHandle } from './types.js';
import { AuditResultCache } from './AuditResultCache.js';
import { createHash } from 'crypto';

export type AuditFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface AuditFinding {
  source: string;
  severity: AuditFindingSeverity;
  message: string;
  evidence?: string;
}

export interface AuditResult {
  decision: RiskDecision;
  score: number;
  findings: AuditFinding[];
  reviewRequired: boolean;
}

export interface HardRuleAnalyzer {
  evaluate(skill: Skill): HardRuleEvaluation;
}

export interface EntropyAnalyzer {
  analyzeContent(content: string): EntropyResult;
}

export interface PermissionAnalyzer {
  analyzePermissions(skill: Skill): PermissionAnalysisResult;
}

export interface AiAnalyzer {
  auditSkill(skill: Skill): Promise<AiAuditResult>;
}

export interface BehaviorAnalyzer {
  analyzeSkill(skill: Skill): Promise<BehaviorValidationResult>;
}

export interface RiskScorer {
  score(signals: RiskSignal[]): { decision: RiskDecision; score: number; reviewRequired: boolean; reason: string };
}

export interface AuditPipelineOptions {
  hardRuleEngine: HardRuleAnalyzer;
  entropyAnalyzer: EntropyAnalyzer;
  permissionAnalyzer: PermissionAnalyzer;
  riskScorer: RiskScorer;
  aiAuditor?: AiAnalyzer;
  behaviorAnalyzer?: BehaviorAnalyzer;
  /** Cache for async audit results. If not provided, a default cache is created. */
  resultCache?: AuditResultCache;
}

/**
 * Result from async audit operation.
 */
export interface AsyncAuditResult {
  syncResult: SyncAuditResult;
  asyncHandle?: AsyncAuditHandle;
}

const ENTROPY_SIGNAL = { weight: 0.3, score: -20 };
const PERMISSION_SIGNAL = { weight: 0.4 };
const AI_SIGNAL: Record<AiAuditResult['riskLevel'], { weight: number; score: number }> = {
  safe: { weight: 0, score: 0 },
  suspicious: { weight: 0.3, score: -30 },
  malicious: { weight: 0.5, score: -50 }
};
const BEHAVIOR_SIGNAL = { weight: 0.6 };

function collectTextSources(skill: Skill): string {
  const parts: string[] = [];

  const meta = skill?.metadata;
  if (meta) {
    parts.push(String(meta.name ?? ''));
    parts.push(String(meta.description ?? ''));
    if (meta.allowedTools) parts.push(String(meta.allowedTools));
  }

  if (typeof skill?.body === 'string') parts.push(skill.body);

  if (skill?.supportFiles) {
    for (const [relativePath, content] of skill.supportFiles.entries()) {
      parts.push(`\n--- support:${relativePath} ---\n`);
      parts.push(content);
    }
  }

  return parts.join('\n');
}

function mapAiSeverity(severity: AiFindingSeverity): AuditFindingSeverity {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function mapViolationSeverity(severity: ViolationSeverity): AuditFindingSeverity {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function behaviorPenaltyScore(result: BehaviorValidationResult): number {
  const raw = typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 100;
  const clamped = Math.min(100, Math.max(0, raw));
  return clamped - 100;
}

export class AuditPipeline {
  private readonly hardRuleEngine: HardRuleAnalyzer;
  private readonly entropyAnalyzer: EntropyAnalyzer;
  private readonly permissionAnalyzer: PermissionAnalyzer;
  private readonly aiAuditor?: AiAnalyzer;
  private readonly behaviorAnalyzer?: BehaviorAnalyzer;
  private readonly riskScorer: RiskScorer;
  private readonly resultCache: AuditResultCache;

  /** Pending async audits keyed by requestId */
  private readonly pendingAudits = new Map<string, {
    promise: Promise<AuditResult>;
    resolve: (result: AuditResult) => void;
    reject: (error: Error) => void;
    status: 'pending' | 'completed' | 'failed';
    result?: AuditResult;
  }>();

  /** Queue for AI audit to limit concurrency */
  private readonly aiQueue: Array<{ skill: Skill; requestId: string }> = [];
  private aiConcurrency = 0;
  private readonly maxAiConcurrency = 3;

  constructor(options: AuditPipelineOptions) {
    this.hardRuleEngine = options.hardRuleEngine;
    this.entropyAnalyzer = options.entropyAnalyzer;
    this.permissionAnalyzer = options.permissionAnalyzer;
    this.aiAuditor = options.aiAuditor;
    this.behaviorAnalyzer = options.behaviorAnalyzer;
    this.riskScorer = options.riskScorer;
    this.resultCache = options.resultCache ?? new AuditResultCache();
  }

  /**
   * Get the result cache for external access.
   */
  getResultCache(): AuditResultCache {
    return this.resultCache;
  }

  /**
   * Generate content hash for cache key.
   */
  private hashSkillContent(skill: Skill): string {
    const content = collectTextSources(skill);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Synchronous fast-path audit. Does NOT call AI auditor.
   * Returns immediately with decision based on hard rules + entropy + permission.
   */
  auditSync(skill: Skill): SyncAuditResult {
    const findings: AuditFinding[] = [];

    // 1. Hard rules check (sync, <1ms)
    const hardRule = this.hardRuleEngine.evaluate(skill);
    if (hardRule.rejected) {
      if (hardRule.reason) {
        findings.push({ source: 'hard_rule', severity: 'critical', message: hardRule.reason });
      }
      return { decision: 'reject', score: 0, reviewRequired: false, findings };
    }

    // 2. Fast soft signals (sync, <5ms)
    const signals: RiskSignal[] = [];

    const content = collectTextSources(skill);
    const entropy = this.entropyAnalyzer.analyzeContent(content);
    if (entropy.suspicious) {
      signals.push({
        source: 'entropy',
        weight: ENTROPY_SIGNAL.weight,
        score: ENTROPY_SIGNAL.score,
        confidence: 1,
        evidence: `highEntropyBlocks=${entropy.highEntropyBlocks.length}; avg=${entropy.averageEntropy.toFixed(2)}`
      });
      findings.push({
        source: 'entropy',
        severity: 'medium',
        message: 'High-entropy content detected',
        evidence: `blocks=${entropy.highEntropyBlocks.length}`
      });
    }

    const permission = this.permissionAnalyzer.analyzePermissions(skill);
    if (permission.score < 0) {
      signals.push({
        source: 'permission',
        weight: PERMISSION_SIGNAL.weight,
        score: permission.score,
        confidence: 1,
        evidence: [
          permission.excessive ? 'excessive=true' : 'excessive=false',
          permission.sensitiveAccess.length ? `sensitiveAccess=${permission.sensitiveAccess.join(',')}` : ''
        ]
          .filter(Boolean)
          .join('; ')
      });
      findings.push({
        source: 'permission',
        severity: permission.excessive ? 'high' : 'medium',
        message: 'Capability manifest indicates elevated risk',
        evidence: `score=${permission.score}`
      });
    }

    // 3. Quick decision based on fast signals
    const scoring = this.riskScorer.score(signals);
    const score = scoring.score;

    let decision: RiskDecision;
    if (score >= 70) {
      decision = 'approve';
    } else if (score < 40) {
      decision = 'reject';
    } else {
      // Provisional approve - will need AI audit async
      decision = 'provisional_approve';
    }

    return {
      decision,
      score,
      reviewRequired: scoring.reviewRequired,
      findings
    };
  }

  /**
   * Async audit that returns fast sync result + optional async handle for AI audit.
   */
  auditAsync(skill: Skill): AsyncAuditResult {
    // Check cache first
    const skillId = skill.metadata?.name ?? 'unknown';
    const contentHash = this.hashSkillContent(skill);
    const cacheKey = AuditResultCache.makeKey(skillId, contentHash);

    const cached = this.resultCache.get(cacheKey);
    if (cached) {
      return {
        syncResult: {
          decision: cached.decision,
          score: cached.score,
          reviewRequired: cached.reviewRequired,
          findings: cached.findings
        }
      };
    }

    // Get sync result
    const syncResult = this.auditSync(skill);

    // If not provisional, no need for async AI audit
    if (syncResult.decision !== 'provisional_approve') {
      // Cache the result
      this.resultCache.set(cacheKey, {
        decision: syncResult.decision,
        score: syncResult.score,
        reviewRequired: syncResult.reviewRequired,
        findings: syncResult.findings
      });
      return { syncResult };
    }

    // Need async AI audit
    if (!this.aiAuditor) {
      // No AI auditor, convert to review
      syncResult.decision = 'review';
      this.resultCache.set(cacheKey, {
        decision: syncResult.decision,
        score: syncResult.score,
        reviewRequired: true,
        findings: syncResult.findings
      });
      return { syncResult };
    }

    // Create async handle
    const requestId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let resolveAudit!: (result: AuditResult) => void;
    let rejectAudit!: (error: Error) => void;
    const promise = new Promise<AuditResult>((resolve, reject) => {
      resolveAudit = resolve;
      rejectAudit = reject;
    });

    const pendingEntry = {
      promise,
      resolve: resolveAudit,
      reject: rejectAudit,
      status: 'pending' as const,
      result: undefined as AuditResult | undefined
    };

    this.pendingAudits.set(requestId, pendingEntry);

    // Queue the AI audit
    this.aiQueue.push({ skill, requestId });
    this.processAiQueue();

    const asyncHandle: AsyncAuditHandle = {
      requestId,
      status: 'pending',
      getResult: () => promise
    };

    syncResult.asyncHandle = asyncHandle;

    return { syncResult, asyncHandle };
  }

  /**
   * Process queued AI audits with concurrency limit.
   */
  private processAiQueue(): void {
    while (this.aiConcurrency < this.maxAiConcurrency && this.aiQueue.length > 0) {
      const item = this.aiQueue.shift();
      if (!item) break;

      this.aiConcurrency++;
      this.runAiAudit(item.skill, item.requestId)
        .finally(() => {
          this.aiConcurrency--;
          this.processAiQueue();
        });
    }
  }

  /**
   * Run AI audit for a skill and update pending entry.
   */
  private async runAiAudit(skill: Skill, requestId: string): Promise<void> {
    const pending = this.pendingAudits.get(requestId);
    if (!pending) return;

    try {
      // Run full audit (including AI)
      const result = await this.audit(skill);

      // Cache the result
      const skillId = skill.metadata?.name ?? 'unknown';
      const contentHash = this.hashSkillContent(skill);
      const cacheKey = AuditResultCache.makeKey(skillId, contentHash);
      this.resultCache.set(cacheKey, result);

      // Update pending entry
      pending.status = 'completed';
      pending.result = result;
      pending.resolve(result);
    } catch (error) {
      pending.status = 'failed';
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get status of an async audit by requestId.
   */
  getAsyncAuditStatus(requestId: string): { status: 'pending' | 'completed' | 'failed' | 'not_found'; result?: AuditResult } {
    const pending = this.pendingAudits.get(requestId);
    if (!pending) {
      return { status: 'not_found' };
    }
    return { status: pending.status, result: pending.result };
  }

  async audit(skill: Skill): Promise<AuditResult> {
    const findings: AuditFinding[] = [];

    const hardRule = this.hardRuleEngine.evaluate(skill);
    if (hardRule.rejected) {
      if (hardRule.reason) {
        findings.push({ source: 'hard_rule', severity: 'critical', message: hardRule.reason });
      }
      return { decision: 'reject', score: 0, reviewRequired: false, findings };
    }

    const signals: RiskSignal[] = [];

    const content = collectTextSources(skill);
    const entropy = this.entropyAnalyzer.analyzeContent(content);
    if (entropy.suspicious) {
      signals.push({
        source: 'entropy',
        weight: ENTROPY_SIGNAL.weight,
        score: ENTROPY_SIGNAL.score,
        confidence: 1,
        evidence: `highEntropyBlocks=${entropy.highEntropyBlocks.length}; avg=${entropy.averageEntropy.toFixed(2)}`
      });
      findings.push({
        source: 'entropy',
        severity: 'medium',
        message: 'High-entropy content detected',
        evidence: `blocks=${entropy.highEntropyBlocks.length}`
      });
    }

    const permission = this.permissionAnalyzer.analyzePermissions(skill);
    if (permission.score < 0) {
      signals.push({
        source: 'permission',
        weight: PERMISSION_SIGNAL.weight,
        score: permission.score,
        confidence: 1,
        evidence: [
          permission.excessive ? 'excessive=true' : 'excessive=false',
          permission.sensitiveAccess.length ? `sensitiveAccess=${permission.sensitiveAccess.join(',')}` : ''
        ]
          .filter(Boolean)
          .join('; ')
      });
      findings.push({
        source: 'permission',
        severity: permission.excessive ? 'high' : 'medium',
        message: 'Capability manifest indicates elevated risk',
        evidence: `score=${permission.score}`
      });
    }

    const aiPromise = this.aiAuditor
      ? this.aiAuditor
          .auditSkill(skill)
          .then((ai) => {
            const cfg = AI_SIGNAL[ai.riskLevel];
            if (cfg.weight > 0 && cfg.score !== 0) {
              signals.push({
                source: `ai:${ai.riskLevel}`,
                weight: cfg.weight,
                score: cfg.score,
                confidence: ai.confidence,
                evidence: ai.explanation
              });
            }

            for (const finding of ai.findings || []) {
              findings.push({
                source: 'ai',
                severity: mapAiSeverity(finding.severity),
                message: `${finding.category}: ${finding.reasoning}`,
                evidence: finding.evidence
              });
            }
          })
          .catch((error: unknown) => {
            findings.push({
              source: 'ai',
              severity: 'medium',
              message: 'AI auditor failed',
              evidence: error instanceof Error ? error.message : String(error)
            });
          })
      : Promise.resolve();

    const behaviorPromise = this.behaviorAnalyzer
      ? this.behaviorAnalyzer
          .analyzeSkill(skill)
          .then((behavior) => {
            const baseScore = behaviorPenaltyScore(behavior);
            if (baseScore < 0) {
              signals.push({
                source: 'behavior',
                weight: BEHAVIOR_SIGNAL.weight,
                score: baseScore,
                confidence: 1,
                evidence: `score=${behavior.score}; violations=${behavior.violations.length}`
              });
            }

            for (const violation of behavior.violations || []) {
              findings.push({
                source: 'behavior',
                severity: mapViolationSeverity(violation.severity),
                message: violation.message
              });
            }
          })
          .catch((error: unknown) => {
            findings.push({
              source: 'behavior',
              severity: 'medium',
              message: 'Behavior analyzer failed',
              evidence: error instanceof Error ? error.message : String(error)
            });
          })
      : Promise.resolve();

    await Promise.all([aiPromise, behaviorPromise]);

    const scoring = this.riskScorer.score(signals);
    return {
      decision: scoring.decision,
      score: scoring.score,
      reviewRequired: scoring.reviewRequired,
      findings
    };
  }
}

