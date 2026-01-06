export type RiskDecision = 'approve' | 'review' | 'reject';

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
