/**
 * Audit Explainer - generates human-readable explanations for audit decisions.
 */

import type { AuditResult, AuditFinding } from './AuditPipeline.js';
import type { RiskDecision } from './types.js';

export interface AuditTimelineEntry {
  stage: string;
  duration: number; // milliseconds
  result: 'pass' | 'fail' | 'suspicious' | 'excessive' | 'malicious' | 'skip';
  details: Array<{ key: string; value: string | number }>;
}

export interface AuditScoringBreakdown {
  source: string;
  weight: number;
  score: number;
  confidence?: number;
  contribution: number;
}

export interface AuditExplanation {
  requestId: string;
  skill: {
    name: string;
    description?: string;
  };
  timeline: AuditTimelineEntry[];
  scoring: AuditScoringBreakdown[];
  finalScore: number;
  decision: RiskDecision;
  recommendation: string;
  findings: AuditFinding[];
  generatedAt: Date;
}

export interface AuditTraceEntry {
  stage: string;
  startTime: number;
  endTime: number;
  result: string;
  data?: Record<string, unknown>;
}

/**
 * Collects audit trace information during audit execution.
 */
export class AuditTracer {
  private readonly entries: AuditTraceEntry[] = [];
  private readonly startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Record a stage execution.
   */
  recordStage(stage: string, result: string, data?: Record<string, unknown>): void {
    this.entries.push({
      stage,
      startTime: this.entries.length > 0
        ? this.entries[this.entries.length - 1].endTime
        : this.startTime,
      endTime: Date.now(),
      result,
      data
    });
  }

  /**
   * Get all recorded entries.
   */
  getEntries(): AuditTraceEntry[] {
    return [...this.entries];
  }

  /**
   * Get total elapsed time.
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * Generates explanations from audit results.
 */
export class AuditExplainer {
  /**
   * Generate a human-readable explanation for an audit result.
   */
  explain(
    requestId: string,
    skillName: string,
    skillDescription: string | undefined,
    result: AuditResult,
    traces?: AuditTraceEntry[]
  ): AuditExplanation {
    const timeline = this.buildTimeline(result, traces);
    const scoring = this.buildScoringBreakdown(result);
    const recommendation = this.generateRecommendation(result);

    return {
      requestId,
      skill: {
        name: skillName,
        description: skillDescription
      },
      timeline,
      scoring,
      finalScore: result.score,
      decision: result.decision,
      recommendation,
      findings: result.findings,
      generatedAt: new Date()
    };
  }

  private buildTimeline(result: AuditResult, traces?: AuditTraceEntry[]): AuditTimelineEntry[] {
    const timeline: AuditTimelineEntry[] = [];

    // Build from traces if available
    if (traces && traces.length > 0) {
      for (const trace of traces) {
        timeline.push({
          stage: trace.stage,
          duration: trace.endTime - trace.startTime,
          result: this.mapResultToTimelineResult(trace.result),
          details: trace.data
            ? Object.entries(trace.data).map(([key, value]) => ({
                key,
                value: typeof value === 'object' ? JSON.stringify(value) : String(value)
              }))
            : []
        });
      }
      return timeline;
    }

    // Build from findings if no traces
    const stageMap = new Map<string, AuditFinding[]>();

    for (const finding of result.findings) {
      const stage = finding.source;
      if (!stageMap.has(stage)) {
        stageMap.set(stage, []);
      }
      stageMap.get(stage)!.push(finding);
    }

    for (const [stage, findings] of stageMap) {
      const worstSeverity = this.getWorstSeverity(findings);
      timeline.push({
        stage,
        duration: 0, // Unknown without traces
        result: this.severityToResult(worstSeverity),
        details: findings.map(f => ({
          key: f.severity,
          value: f.message
        }))
      });
    }

    return timeline;
  }

  private buildScoringBreakdown(result: AuditResult): AuditScoringBreakdown[] {
    const breakdown: AuditScoringBreakdown[] = [];

    // Extract scoring info from findings
    const sourceScores = new Map<string, { weight: number; score: number; confidence?: number }>();

    for (const finding of result.findings) {
      const source = finding.source;

      // Parse evidence for score info if available
      const evidenceMatch = finding.evidence?.match(/score=(-?\d+)/);
      const score = evidenceMatch ? parseInt(evidenceMatch[1], 10) : 0;

      // Estimate weights based on source
      let weight = 0.3;
      if (source === 'hard_rule') weight = 1.0;
      else if (source === 'permission') weight = 0.4;
      else if (source === 'ai') weight = 0.5;
      else if (source === 'behavior') weight = 0.6;

      if (!sourceScores.has(source) || Math.abs(score) > Math.abs(sourceScores.get(source)!.score)) {
        sourceScores.set(source, { weight, score });
      }
    }

    for (const [source, info] of sourceScores) {
      const contribution = info.score * info.weight * (info.confidence ?? 1);
      breakdown.push({
        source,
        weight: info.weight,
        score: info.score,
        confidence: info.confidence,
        contribution
      });
    }

    return breakdown;
  }

  private generateRecommendation(result: AuditResult): string {
    switch (result.decision) {
      case 'approve':
        return '该技能通过了所有安全检查，可以安全使用。';

      case 'reject':
        const criticalFindings = result.findings.filter(f => f.severity === 'critical');
        if (criticalFindings.length > 0) {
          return `该技能因严重安全问题被拒绝：${criticalFindings[0].message}`;
        }
        return '该技能未通过安全审计，建议不要使用。';

      case 'review':
        const concerns = result.findings
          .filter(f => f.severity === 'medium' || f.severity === 'high')
          .map(f => f.message)
          .slice(0, 3);
        return `需要人工审核。关注点：${concerns.join('；') || '综合风险评分需要复核'}`;

      case 'provisional_approve':
        return '临时放行中，AI 审计正在后台运行。最终结果将在审计完成后更新。';

      default:
        return '审计状态未知，请联系管理员。';
    }
  }

  private mapResultToTimelineResult(result: string): AuditTimelineEntry['result'] {
    const lower = result.toLowerCase();
    if (lower === 'pass' || lower === 'approved' || lower === 'safe') return 'pass';
    if (lower === 'fail' || lower === 'rejected' || lower === 'blocked') return 'fail';
    if (lower === 'suspicious') return 'suspicious';
    if (lower === 'excessive') return 'excessive';
    if (lower === 'malicious') return 'malicious';
    return 'skip';
  }

  private getWorstSeverity(findings: AuditFinding[]): AuditFinding['severity'] {
    const order: AuditFinding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];

    for (const severity of order) {
      if (findings.some(f => f.severity === severity)) {
        return severity;
      }
    }

    return 'info';
  }

  private severityToResult(severity: AuditFinding['severity']): AuditTimelineEntry['result'] {
    switch (severity) {
      case 'critical': return 'fail';
      case 'high': return 'suspicious';
      case 'medium': return 'suspicious';
      case 'low': return 'pass';
      case 'info': return 'pass';
      default: return 'pass';
    }
  }
}
