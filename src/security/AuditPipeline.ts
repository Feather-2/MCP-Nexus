import type { Skill } from '../skills/types.js';
import type { HardRuleEvaluation } from './HardRuleEngine.js';
import type { EntropyResult } from './analyzers/EntropyAnalyzer.js';
import type { PermissionAnalysisResult } from './analyzers/PermissionAnalyzer.js';
import type { AiAuditResult, AiFindingSeverity } from './AiAuditor.js';
import type { BehaviorValidationResult, ViolationSeverity } from './BehaviorValidator.js';
import type { RiskDecision, RiskSignal } from './types.js';

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

  constructor(options: AuditPipelineOptions) {
    this.hardRuleEngine = options.hardRuleEngine;
    this.entropyAnalyzer = options.entropyAnalyzer;
    this.permissionAnalyzer = options.permissionAnalyzer;
    this.aiAuditor = options.aiAuditor;
    this.behaviorAnalyzer = options.behaviorAnalyzer;
    this.riskScorer = options.riskScorer;
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

