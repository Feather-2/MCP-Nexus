import type { Skill } from '../../skills/types.js';

export interface PermissionAnalysisResult {
  /**
   * True when the declared permissions are clearly over-broad (e.g. filesystem.write includes "/").
   */
  excessive: boolean;
  /**
   * Canonical sensitive locations detected either in declared capabilities or in skill code/config content.
   */
  sensitiveAccess: string[];
  /**
   * A penalty score (0 = no issues, negative values indicate risk).
   * Intended to be consumed as a soft signal by a higher-level risk scorer.
   */
  score: number;
}

interface EvaluationSource {
  label: string;
  content: string;
}

const SENSITIVE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '~/.ssh', pattern: /~[\\/]\.ssh(?:[\\/]|\b)/i },
  { label: '~/.aws', pattern: /~[\\/]\.aws(?:[\\/]|\b)/i },
  { label: '/etc/passwd', pattern: /(?:^|[^\p{L}\p{N}_-])[\\/]+etc[\\/]+passwd\b/iu }
];

function normalizeFsSpec(input: string): string {
  let s = String(input ?? '').trim();
  if (!s) return '';

  // Strip common quoting wrappers.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  // Normalize path separators for easier matching.
  s = s.replace(/\\/g, '/');

  // Collapse duplicate slashes except for leading UNC-ish paths (which we don't expect here).
  s = s.replace(/\/{2,}/g, '/');

  // Strip trailing slash (but keep root "/").
  if (s.length > 1) s = s.replace(/\/+$/g, '');

  return s;
}

function isUnboundedPathSpec(spec: string): boolean {
  const normalized = normalizeFsSpec(spec);
  if (!normalized) return true;
  if (normalized === '*' || normalized === '/*' || normalized === '/**') return true;
  if (normalized === '/') return true;

  // Windows drive roots, e.g. "C:\\" or "C:/" or "C:".
  if (/^[a-zA-Z]:$/.test(normalized)) return true;
  if (/^[a-zA-Z]:\/$/.test(normalized)) return true;

  // Tilde-root (home dir) is also very broad; treat as unbounded for scoring purposes.
  if (normalized === '~' || normalized === '~/' || normalized === '~/') return true;

  return false;
}

function collectSources(skill: Skill): EvaluationSource[] {
  const sources: EvaluationSource[] = [
    { label: 'skill.body', content: skill.body },
    { label: 'skill.metadata', content: `${skill.metadata.name}\n${skill.metadata.description}` }
  ];

  if (skill.metadata.allowedTools) {
    sources.push({ label: 'skill.metadata.allowedTools', content: skill.metadata.allowedTools });
  }

  if (skill.supportFiles) {
    for (const [relativePath, content] of skill.supportFiles.entries()) {
      sources.push({ label: `skill.supportFiles:${relativePath}`, content });
    }
  }

  return sources;
}

function detectSensitiveLocations(inputs: string[]): Set<string> {
  const matches = new Set<string>();
  for (const raw of inputs) {
    const normalized = normalizeFsSpec(raw);
    if (!normalized) continue;
    for (const { label, pattern } of SENSITIVE_PATTERNS) {
      if (pattern.test(normalized)) matches.add(label);
    }
  }
  return matches;
}

function detectSensitiveInText(text: string, out: Set<string>): void {
  const input = String(text ?? '');
  if (!input) return;
  for (const { label, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(input)) out.add(label);
  }
}

function inferImpliedNeeds(sources: EvaluationSource[]): {
  filesystemRead: boolean;
  filesystemWrite: boolean;
  network: boolean;
  subprocess: boolean;
  envVars: Set<string>;
} {
  const combined = sources.map((s) => s.content).join('\n');

  const filesystemRead =
    /\bfilesystem\.read\b/i.test(combined) ||
    /\b(?:readFile|readFileSync)\b/.test(combined) ||
    /\bcat\s+[^>\n]+/.test(combined) ||
    /\b(?:grep|find|ls)\b/.test(combined);

  const filesystemWrite =
    /\bfilesystem\.write\b/i.test(combined) ||
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync)\b/.test(combined) ||
    /\b(?:touch|tee)\b/.test(combined) ||
    /\bcat\s+[^>\n]+\s*>\s*\S+/.test(combined);

  const network =
    /\bhttps?:\/\//i.test(combined) ||
    /\bfetch\s*\(/.test(combined) ||
    /\baxios\b/i.test(combined) ||
    /\b(?:curl|wget)\b/i.test(combined);

  const subprocess =
    /\bfilesystem\.exec\b/i.test(combined) ||
    /\bchild_process\b/.test(combined) ||
    /\b(?:exec|spawn)\s*\(/.test(combined) ||
    /\b(?:bash|sh|powershell|cmd\.exe)\b/i.test(combined);

  const envVars = new Set<string>();
  for (const match of combined.matchAll(/\bprocess\.env\.([A-Z0-9_]+)\b/g)) {
    const key = String(match[1] ?? '').trim();
    if (key) envVars.add(key);
  }

  return { filesystemRead, filesystemWrite, network, subprocess, envVars };
}

export class PermissionAnalyzer {
  analyzePermissions(skill: Skill): PermissionAnalysisResult {
    const sources = collectSources(skill);

    const declaredFsRead = Array.isArray(skill.capabilities?.filesystem?.read) ? skill.capabilities.filesystem.read : [];
    const declaredFsWrite = Array.isArray(skill.capabilities?.filesystem?.write) ? skill.capabilities.filesystem.write : [];

    const excessive =
      declaredFsWrite.some((p) => isUnboundedPathSpec(p)) ||
      // Root read is also very risky in practice, but lower severity than write.
      declaredFsRead.some((p) => normalizeFsSpec(p) === '/');

    const sensitiveAccess = new Set<string>();

    // Declared capability sensitive paths.
    for (const label of detectSensitiveLocations([...declaredFsRead, ...declaredFsWrite])) {
      sensitiveAccess.add(label);
    }

    // Content-based sensitive paths.
    for (const source of sources) {
      detectSensitiveInText(source.content, sensitiveAccess);
    }

    const implied = inferImpliedNeeds(sources);

    // Penalty-only score: 0 means no issues; negative values accumulate risk.
    let score = 0;

    if (excessive) score -= 30;

    // Sensitive locations are high-signal; cap to avoid runaway penalties.
    if (sensitiveAccess.size > 0) {
      score -= Math.min(60, sensitiveAccess.size * 20);
    }

    // Under-declared capabilities: the skill implies behaviors it hasn't declared.
    if (implied.filesystemRead && declaredFsRead.length === 0) score -= 10;
    if (implied.filesystemWrite && declaredFsWrite.length === 0) score -= 15;

    const netHosts = Array.isArray(skill.capabilities?.network?.allowedHosts) ? skill.capabilities.network.allowedHosts : [];
    const netPorts = Array.isArray(skill.capabilities?.network?.allowedPorts) ? skill.capabilities.network.allowedPorts : [];
    if (implied.network && (netHosts.length === 0 || netPorts.length === 0)) score -= 10;

    const subprocessAllowed = Boolean(skill.capabilities?.subprocess?.allowed);
    if (implied.subprocess && !subprocessAllowed) score -= 15;

    const declaredEnv = Array.isArray(skill.capabilities?.env) ? skill.capabilities.env : [];
    if (implied.envVars.size > 0) {
      let missing = 0;
      for (const v of implied.envVars) {
        if (!declaredEnv.includes(v)) missing++;
      }
      score -= Math.min(20, missing * 5);
    }

    // Clamp to a reasonable range to keep downstream scoring stable.
    if (score < -100) score = -100;
    if (score > 0) score = 0;

    return {
      excessive,
      sensitiveAccess: [...sensitiveAccess].sort(),
      score
    };
  }
}
