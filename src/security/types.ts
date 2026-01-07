export type RiskDecision = 'approve' | 'review' | 'reject' | 'provisional_approve';

/**
 * Handle for tracking async audit completion.
 */
export interface AsyncAuditHandle {
  requestId: string;
  status: 'pending' | 'completed' | 'failed';
  getResult(): Promise<import('./AuditPipeline.js').AuditResult>;
}

/**
 * Result from synchronous (fast-path) audit.
 */
export interface SyncAuditResult {
  decision: RiskDecision;
  score: number;
  findings: import('./AuditPipeline.js').AuditFinding[];
  reviewRequired: boolean;
  /** Present when decision is provisional_approve and AI audit is running async. */
  asyncHandle?: AsyncAuditHandle;
}

export interface RiskSignal {
  /**
   * Signal identifier / origin (e.g. "ai", "entropy", "canary_triggered").
   */
  source: string;
  /**
   * Weight multiplier applied to the base score contribution.
   */
  weight: number;
  /**
   * Base score contribution (positive or negative).
   */
  score: number;
  /**
   * Confidence in the signal, in the range [0, 1].
   * Currently required for all signals so callers can set it to 1 for deterministic checks.
   */
  confidence: number;
  /**
   * Human-readable evidence / explanation for this signal.
   */
  evidence: string;
}

export interface ScoringResult {
  decision: RiskDecision;
  score: number;
  reviewRequired: boolean;
  reason: string;
}
