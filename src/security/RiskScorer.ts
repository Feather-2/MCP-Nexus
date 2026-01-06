import type { RiskDecision, RiskSignal, ScoringResult } from './types.js';

/**
 * A normalized list of "one strike" sources that lead to an immediate rejection.
 * These are deterministic / high-confidence signals (e.g. canary access, malware signatures).
 */
export const HARD_REJECT = [
  'command_blacklist',
  'malware_signature',
  'malware_signatures',
  'canary_triggered',
  'critical_cve',
  'sandbox_escape',
  'hard_rule'
] as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function normalizeKey(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sourceCandidates(source: unknown): string[] {
  const raw = typeof source === 'string' ? source.trim() : String(source ?? '').trim();
  if (!raw) return [];

  const candidates = new Set<string>();
  candidates.add(raw);

  const tokens = raw.split(/[:/\\.#]/g).map((t) => t.trim()).filter(Boolean);
  const tail = tokens.at(-1);
  if (tail) candidates.add(tail);

  return [...candidates];
}

function isAiSignal(source: string): boolean {
  const raw = String(source ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'ai') return true;
  return raw.startsWith('ai:') || raw.startsWith('ai/') || raw.startsWith('ai_') || raw.startsWith('ai-') || raw.startsWith('ai.');
}

function buildThresholdReason(decision: RiskDecision, score: number): string {
  if (decision === 'approve') return `score ${score} >= 70`;
  if (decision === 'review') return `score ${score} between 40 and 69`;
  return `score ${score} < 40`;
}

export class RiskScorer {
  private readonly hardRejectSet = new Set<string>(HARD_REJECT.map((v) => normalizeKey(v)));

  score(signals: RiskSignal[]): ScoringResult {
    const list = Array.isArray(signals) ? signals : [];

    for (const signal of list) {
      const candidates = sourceCandidates(signal?.source);
      const hit = candidates.some((candidate) => this.hardRejectSet.has(normalizeKey(candidate)));
      if (!hit) continue;
      const evidence = typeof signal?.evidence === 'string' ? signal.evidence.trim() : '';
      return {
        decision: 'reject',
        score: 0,
        reviewRequired: false,
        reason: evidence ? `Hard reject: ${signal.source} (${evidence})` : `Hard reject: ${signal.source}`
      };
    }

    let totalImpact = 0;
    let seenSignal = false;

    for (const signal of list) {
      if (!signal) continue;
      seenSignal = true;

      const weight = typeof signal.weight === 'number' && Number.isFinite(signal.weight) ? Math.max(0, signal.weight) : 0;
      const base = typeof signal.score === 'number' && Number.isFinite(signal.score) ? signal.score : 0;

      const ai = isAiSignal(signal.source);
      const confidence = ai ? clamp01(signal.confidence) : 1;

      const impactRaw = base * weight * confidence;
      const impact = impactRaw === 0 ? 0 : impactRaw;
      totalImpact += impact;
    }

    const scoreRaw = 100 + totalImpact;
    const score = clampScore(scoreRaw === 0 ? 0 : scoreRaw);

    const decision: RiskDecision = score >= 70 ? 'approve' : score >= 40 ? 'review' : 'reject';
    const reviewRequired = decision === 'review';

    const reason = seenSignal ? buildThresholdReason(decision, score) : 'no signals provided';
    return { decision, score, reviewRequired, reason };
  }
}
