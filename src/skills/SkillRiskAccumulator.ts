import type { RiskFlag } from './SkillDiffAnalyzer.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AccumulatedRisk {
  skillId: string;
  recentChanges: {
    timestamp: number;
    riskFlags: RiskFlag[];
  }[];
  criticalFlags: RiskFlag[];
  highFlags: RiskFlag[];
  mediumFlags: RiskFlag[];
  lowFlags: RiskFlag[];
  escalationCount: number;
}

export interface ThresholdResult {
  exceedsThreshold: boolean;
  reasons: string[];
}

export interface SkillRiskAccumulatorOptions {
  windowMs?: number;
  nowProvider?: () => number;
}

interface RiskChangeRecord {
  timestamp: number;
  riskFlags: RiskFlag[];
}

function normalizeSkillId(skillId: string): string {
  const normalized = String(skillId || '').trim();
  if (!normalized) {
    throw new Error('Skill id is required');
  }
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  return normalized;
}

function normalizeTimestamp(timestamp: number, fallback: number): number {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return fallback;
  }
  return timestamp;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function cloneRiskFlag(flag: RiskFlag): RiskFlag {
  const added = normalizeStringArray(flag.details?.added);
  const removed = normalizeStringArray(flag.details?.removed);
  const modified = normalizeStringArray(flag.details?.modified);

  return {
    type: flag.type,
    description: flag.description,
    severity: flag.severity,
    isEscalation: flag.isEscalation,
    details: {
      ...(added ? { added } : {}),
      ...(removed ? { removed } : {}),
      ...(modified ? { modified } : {})
    }
  };
}

function normalizeRiskFlag(flag: RiskFlag): RiskFlag {
  const validTypes: RiskFlag['type'][] = ['permission', 'network', 'filesystem', 'code'];
  const validSeverity: RiskFlag['severity'][] = ['critical', 'high', 'medium', 'low'];

  const normalizedType = validTypes.includes(flag.type) ? flag.type : 'code';
  const normalizedSeverity = validSeverity.includes(flag.severity) ? flag.severity : 'low';
  const normalizedDescription = String(flag.description || '').trim() || 'Risk flag detected';

  return {
    type: normalizedType,
    description: normalizedDescription,
    severity: normalizedSeverity,
    isEscalation: Boolean(flag.isEscalation),
    details: cloneRiskFlag(flag).details
  };
}

function cloneChange(change: RiskChangeRecord): RiskChangeRecord {
  return {
    timestamp: change.timestamp,
    riskFlags: change.riskFlags.map((flag) => cloneRiskFlag(flag))
  };
}

export class SkillRiskAccumulator {
  private readonly skillChanges = new Map<string, RiskChangeRecord[]>();
  private readonly windowMs: number;
  private readonly nowProvider: () => number;

  constructor(options: SkillRiskAccumulatorOptions = {}) {
    this.windowMs = Number.isFinite(options.windowMs) && (options.windowMs ?? 0) > 0
      ? Math.floor(options.windowMs as number)
      : DEFAULT_WINDOW_MS;
    this.nowProvider = options.nowProvider ?? Date.now;
  }

  accumulateRisk(skillId: string, riskFlags: RiskFlag[], timestamp: number): AccumulatedRisk {
    const normalizedSkillId = normalizeSkillId(skillId);
    const now = this.nowProvider();
    const normalizedTimestamp = normalizeTimestamp(timestamp, now);
    const normalizedFlags = (Array.isArray(riskFlags) ? riskFlags : [])
      .map((flag) => normalizeRiskFlag(flag))
      .map((flag) => cloneRiskFlag(flag));

    const history = this.skillChanges.get(normalizedSkillId) ?? [];
    history.push({
      timestamp: normalizedTimestamp,
      riskFlags: normalizedFlags
    });

    const pruned = this.pruneChanges(history, now);
    if (pruned.length === 0) {
      this.skillChanges.delete(normalizedSkillId);
    } else {
      this.skillChanges.set(normalizedSkillId, pruned);
    }
    return this.buildAccumulatedRisk(normalizedSkillId, pruned);
  }

  checkThreshold(skillId: string): ThresholdResult {
    const accumulated = this.getAccumulatedRisk(skillId);
    const reasons: string[] = [];
    const highCount = accumulated.highFlags.length;
    const mediumLowCount = accumulated.mediumFlags.length + accumulated.lowFlags.length;

    if (accumulated.criticalFlags.length > 0) {
      reasons.push(`Critical risk flags detected: ${accumulated.criticalFlags.length}`);
    }
    if (highCount > 3) {
      reasons.push(`High severity risk flags exceed threshold (>3): ${highCount}`);
    }
    if (accumulated.escalationCount > 0) {
      reasons.push(`Escalation risk detected: ${accumulated.escalationCount}`);
    }
    if (mediumLowCount > 10) {
      reasons.push(`Medium/low risk flags exceed threshold (>10): ${mediumLowCount}`);
    }

    return {
      exceedsThreshold: reasons.length > 0,
      reasons
    };
  }

  getAccumulatedRisk(skillId: string): AccumulatedRisk {
    const normalizedSkillId = normalizeSkillId(skillId);
    const history = this.skillChanges.get(normalizedSkillId) ?? [];
    const pruned = this.pruneChanges(history, this.nowProvider());
    this.skillChanges.set(normalizedSkillId, pruned);
    return this.buildAccumulatedRisk(normalizedSkillId, pruned);
  }

  private pruneChanges(changes: RiskChangeRecord[], now: number): RiskChangeRecord[] {
    const cutoff = now - this.windowMs;
    return changes
      .filter((change) => change.timestamp >= cutoff)
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((change) => cloneChange(change));
  }

  private buildAccumulatedRisk(skillId: string, changes: RiskChangeRecord[]): AccumulatedRisk {
    const criticalFlags: RiskFlag[] = [];
    const highFlags: RiskFlag[] = [];
    const mediumFlags: RiskFlag[] = [];
    const lowFlags: RiskFlag[] = [];
    let escalationCount = 0;

    for (const change of changes) {
      for (const rawFlag of change.riskFlags) {
        const flag = normalizeRiskFlag(rawFlag);
        if (flag.isEscalation) {
          escalationCount += 1;
        }

        if (flag.severity === 'critical') {
          criticalFlags.push(flag);
        } else if (flag.severity === 'high') {
          highFlags.push(flag);
        } else if (flag.severity === 'medium') {
          mediumFlags.push(flag);
        } else {
          lowFlags.push(flag);
        }
      }
    }

    return {
      skillId,
      recentChanges: changes.map((change) => cloneChange(change)),
      criticalFlags,
      highFlags,
      mediumFlags,
      lowFlags,
      escalationCount
    };
  }
}
