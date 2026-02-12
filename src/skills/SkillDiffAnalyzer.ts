export interface RiskFlag {
  type: 'permission' | 'network' | 'filesystem' | 'code';
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  isEscalation: boolean;
  details: {
    added?: string[];
    removed?: string[];
    modified?: string[];
  };
}

export type DiffAnalysis = RiskFlag[];

type RiskType = RiskFlag['type'];
type RiskSeverity = RiskFlag['severity'];

type RiskDetailsAccumulator = Record<RiskType, {
  added: string[];
  removed: string[];
}>;

const RISK_TYPE_ORDER: RiskType[] = ['permission', 'network', 'filesystem', 'code'];

const RISK_PATTERNS: Record<RiskType, RegExp[]> = {
  permission: [
    /\bpermission(s)?\b/i,
    /\bcapabilit(y|ies)\b/i,
    /\ballowedtools\b/i,
    /\bprivileged\b/i,
    /\broot\b/i,
    /\bsudo\b/i,
    /\bauthori[sz]ation\b/i,
    /\bauth\b/i
  ],
  network: [
    /\bnetwork\b/i,
    /\ballowedhosts?\b/i,
    /\ballowedports?\b/i,
    /\bhost\b/i,
    /\bport\b/i,
    /\bhttps?:\/\/\S+/i,
    /\bsocket\b/i,
    /\bcurl\b/i,
    /\bwget\b/i
  ],
  filesystem: [
    /\bfilesystem\b/i,
    /\bfile[-_\s]?system\b/i,
    /\bpath(s)?\b/i,
    /\bdirector(y|ies)\b/i,
    /\bread[-_\s]?only\b/i,
    /\bwrite\b/i,
    /\bdelete\b/i,
    /\brm\s+-rf\b/i,
    /\bchmod\b/i
  ],
  code: [
    /```/,
    /\bscript\b/i,
    /\bexec\b/i,
    /\beval\b/i,
    /\bchild_process\b/i,
    /\bnode\b/i,
    /\bpython\b/i,
    /\bbash\b/i,
    /\bcurl\b/i,
    /\bwget\b/i
  ]
};

const ESCALATION_PATTERNS: Record<RiskType, RegExp[]> = {
  permission: [
    /\ballow(ed)?\s+all\b/i,
    /\ballowedtools\s*:\s*\*/i,
    /\bpermissions?\s*:\s*\*/i,
    /\bfull\s+access\b/i,
    /\bprivileged\b/i,
    /\broot\b/i,
    /\bsudo\b/i,
    /\bdisable\b.*\b(security|sandbox|auth|restriction)\b/i
  ],
  network: [
    /\ballowedhosts?\s*:\s*\[[^\]]*\*[^\]]*\]/i,
    /\ballowedports?\s*:\s*\[[^\]]*\*[^\]]*\]/i,
    /\b0\.0\.0\.0\b/,
    /\bany\s+host\b/i,
    /\bany\s+port\b/i,
    /\binternet\s+access\b/i,
    /\bexternal\s+network\b/i
  ],
  filesystem: [
    /\bwrite\s+all\b/i,
    /\bdelete\s+all\b/i,
    /\bany\s+path\b/i,
    /\brm\s+-rf\s+\/\b/i,
    /\bchmod\s+777\b/i,
    /\bfilesystem\.(read|write)\s*:\s*\*/i
  ],
  code: [
    /\bcurl\b.*\|\s*sh\b/i,
    /\bwget\b.*\|\s*sh\b/i,
    /\beval\(/i,
    /\bexec\(/i,
    /\bspawn\(/i,
    /\bnew Function\b/i,
    /\bchild_process\b/i
  ]
};

const CRITICAL_PATTERNS: Record<RiskType, RegExp[]> = {
  permission: [
    /\broot\b/i,
    /\bsudo\b/i,
    /\bprivileged\b/i,
    /\ballowedtools\s*:\s*\*/i,
    /\ballow(ed)?\s+all\b/i,
    /\bdisable\b.*\b(security|sandbox|auth)\b/i
  ],
  network: [
    /\ballowedhosts?\s*:\s*\[[^\]]*\*[^\]]*\]/i,
    /\ballowedports?\s*:\s*\[[^\]]*\*[^\]]*\]/i,
    /\b0\.0\.0\.0\b/,
    /\bany\s+port\b/i
  ],
  filesystem: [
    /\brm\s+-rf\s+\/\b/i,
    /\bchmod\s+777\b/i,
    /\bwrite\s+all\b/i,
    /\bdelete\s+all\b/i
  ],
  code: [
    /\bcurl\b.*\|\s*sh\b/i,
    /\bwget\b.*\|\s*sh\b/i,
    /\beval\(/i,
    /\bexec\(/i,
    /\bnew Function\b/i
  ]
};

const RESTRICTION_PATTERNS: RegExp[] = [
  /\bdeny\b/i,
  /\brestrict(ed|ion)?\b/i,
  /\bforbid(den)?\b/i,
  /\bwhitelist\b/i,
  /\ballowlist\b/i,
  /\bread[-_\s]?only\b/i,
  /\bno\s+network\b/i,
  /\blocalhost\b/i,
  /\b127\.0\.0\.1\b/i,
  /\blimited?\b/i
];

const DESCRIPTION_BY_TYPE: Record<RiskType, string> = {
  permission: 'Permission-related directives changed',
  network: 'Network access directives changed',
  filesystem: 'Filesystem access directives changed',
  code: 'Code or execution directives changed'
};

function normalizeLines(content: string): string[] {
  return String(content ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function buildLineCountMap(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function subtractLines(source: string[], subtract: string[]): string[] {
  const subtractCounts = buildLineCountMap(subtract);
  const remaining: string[] = [];

  for (const line of source) {
    const count = subtractCounts.get(line) ?? 0;
    if (count > 0) {
      subtractCounts.set(line, count - 1);
      continue;
    }
    remaining.push(line);
  }

  return remaining;
}

function uniqueLines(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function matchesAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function detectRiskTypes(line: string): RiskType[] {
  const matched = RISK_TYPE_ORDER.filter((riskType) => matchesAny(line, RISK_PATTERNS[riskType]));
  if (matched.length > 0) return matched;
  return ['code'];
}

function buildModifiedHints(added: string[], removed: string[]): string[] | undefined {
  if (!added.length || !removed.length) return undefined;
  const count = Math.min(added.length, removed.length, 5);
  const hints: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = removed[index];
    const after = added[index];
    if (!before || !after) continue;
    hints.push(`${before} => ${after}`);
  }
  return hints.length > 0 ? hints : undefined;
}

function inferEscalation(type: RiskType, added: string[], removed: string[]): boolean {
  if (added.some((line) => matchesAny(line, ESCALATION_PATTERNS[type]))) {
    return true;
  }
  return removed.some((line) => matchesAny(line, RESTRICTION_PATTERNS));
}

function inferSeverity(type: RiskType, added: string[], removed: string[], isEscalation: boolean): RiskSeverity {
  const changedLines = [...added, ...removed];
  if (changedLines.some((line) => matchesAny(line, CRITICAL_PATTERNS[type]))) {
    return 'critical';
  }
  if (isEscalation) {
    return 'high';
  }
  if (changedLines.length >= 4) {
    return 'medium';
  }
  return 'low';
}

function buildDescription(type: RiskType, added: string[], removed: string[], isEscalation: boolean): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.length}`);
  if (removed.length > 0) parts.push(`removed ${removed.length}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'changed';
  return `${DESCRIPTION_BY_TYPE[type]} (${summary})${isEscalation ? '; escalation detected' : ''}`;
}

function createEmptyAccumulator(): RiskDetailsAccumulator {
  return {
    permission: { added: [], removed: [] },
    network: { added: [], removed: [] },
    filesystem: { added: [], removed: [] },
    code: { added: [], removed: [] }
  };
}

export class SkillDiffAnalyzer {
  analyzeDiff(oldContent: string, newContent: string): RiskFlag[] {
    const normalizedOld = String(oldContent ?? '');
    const normalizedNew = String(newContent ?? '');
    if (normalizedOld === normalizedNew) {
      return [];
    }

    const oldLines = normalizeLines(normalizedOld);
    const newLines = normalizeLines(normalizedNew);
    const addedLines = subtractLines(newLines, oldLines);
    const removedLines = subtractLines(oldLines, newLines);
    const grouped = createEmptyAccumulator();

    for (const line of addedLines) {
      for (const riskType of detectRiskTypes(line)) {
        grouped[riskType].added.push(line);
      }
    }

    for (const line of removedLines) {
      for (const riskType of detectRiskTypes(line)) {
        grouped[riskType].removed.push(line);
      }
    }

    const flags: RiskFlag[] = [];

    for (const riskType of RISK_TYPE_ORDER) {
      const added = uniqueLines(grouped[riskType].added);
      const removed = uniqueLines(grouped[riskType].removed);
      if (added.length === 0 && removed.length === 0) {
        continue;
      }

      const isEscalation = inferEscalation(riskType, added, removed);
      const modified = buildModifiedHints(added, removed);
      flags.push({
        type: riskType,
        description: buildDescription(riskType, added, removed, isEscalation),
        severity: inferSeverity(riskType, added, removed, isEscalation),
        isEscalation,
        details: {
          ...(added.length > 0 ? { added } : {}),
          ...(removed.length > 0 ? { removed } : {}),
          ...(modified ? { modified } : {})
        }
      });
    }

    return flags;
  }
}
