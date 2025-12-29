import type { MatchResult, Skill } from './types.js';

export interface ScoredSkillMatch {
  skill: Skill;
  result: MatchResult;
}

export interface SkillMatcherOptions {
  /**
   * Minimum score to be considered a match.
   */
  minScore?: number;
  /**
   * Maximum matches to return (default: 5).
   */
  maxResults?: number;
}

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
  return matches.map((t) => t.trim()).filter(Boolean);
}

function intersectCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const v of a) {
    if (b.has(v)) count += 1;
  }
  return count;
}

function setFromArray(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const n = normalizeText(v);
    if (!n) continue;
    out.add(n);
  }
  return out;
}

function explicitMentionScore(input: string, skillName: string): { score: number; reason?: string } {
  const name = normalizeText(skillName);
  if (!name) return { score: 0 };
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\$${escaped}(\\b|$)`, 'i').test(input)) return { score: 1, reason: 'explicit $skill mention' };
  if (new RegExp(`\\bskill\\s*:\\s*${escaped}(\\b|$)`, 'i').test(input)) return { score: 1, reason: 'explicit skill:name mention' };
  if (new RegExp(`\\b${escaped}\\b`, 'i').test(input)) return { score: 0.65, reason: 'skill name mentioned' };
  return { score: 0 };
}

export class SkillMatcher {
  match(input: string, skills: Skill[], options?: SkillMatcherOptions): ScoredSkillMatch[] {
    const normalized = normalizeText(input);
    const minScore = options?.minScore ?? 0.25;
    const maxResults = options?.maxResults ?? 5;

    const inputTokens = new Set<string>(tokenize(normalized));

    const matches: ScoredSkillMatch[] = [];

    for (const skill of skills) {
      const nameScore = explicitMentionScore(normalized, skill.metadata.name);

      const keywordSet = setFromArray(skill.metadata.keywordsAll);
      const overlap = intersectCount(inputTokens, keywordSet);
      const overlapRatio = keywordSet.size > 0 ? overlap / Math.min(keywordSet.size, 12) : 0;

      // Base signal from keyword overlap; capped to keep explicit mentions dominant.
      const keywordScore = Math.min(0.8, overlapRatio * 1.2);

      // Priority provides a slight deterministic tiebreaker, not a strong signal.
      const priorityBoost = Math.max(0, Math.min(0.1, (skill.metadata.priority || 0) / 1000));

      let score = Math.max(nameScore.score, keywordScore) + priorityBoost;
      score = Math.max(0, Math.min(1, score));

      const matched = score >= minScore;
      if (!matched) continue;

      const reasons: string[] = [];
      if (nameScore.reason) reasons.push(nameScore.reason);
      if (overlap > 0) reasons.push(`keyword overlap: ${overlap}`);
      if (priorityBoost > 0) reasons.push(`priority boost: ${priorityBoost.toFixed(3)}`);

      matches.push({
        skill,
        result: {
          matched: true,
          score: Math.round(score * 1000) / 1000,
          reason: reasons.join('; ') || 'matched'
        }
      });
    }

    matches.sort((a, b) => {
      if (b.result.score !== a.result.score) return b.result.score - a.result.score;
      if (b.skill.metadata.priority !== a.skill.metadata.priority) return b.skill.metadata.priority - a.skill.metadata.priority;
      return a.skill.metadata.name.localeCompare(b.skill.metadata.name);
    });

    return matches.slice(0, maxResults);
  }

  formatInjection(skills: Skill[]): string {
    const blocks = skills.map((s) => {
      const headerLines = [
        `## Skill: ${s.metadata.name}`,
        s.metadata.description ? `- Description: ${s.metadata.description}` : undefined,
        s.metadata.allowedTools ? `- AllowedTools: ${s.metadata.allowedTools}` : undefined
      ].filter(Boolean);
      return `${headerLines.join('\n')}\n\n${s.body.trim()}\n`;
    });
    return blocks.join('\n');
  }
}

