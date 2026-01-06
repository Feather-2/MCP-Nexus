import type { MatchResult, Skill } from './types.js';

export interface ScoredSkillMatch {
  skill: Skill;
  result: MatchResult;
}

export interface SkillMatcherIndex {
  skills: Skill[];
  /**
   * Normalized (lowercased/trimmed) skill name to internal skill ID.
   */
  nameToSkillId: Map<string, number>;
  /**
   * Normalized token to a posting list of internal skill IDs.
   */
  tokenToSkillIds: Map<string, number[]>;
  /**
   * Precomputed denominator for keyword overlap ratio: `min(keywordTokenCount, 12)`.
   */
  keywordDenomById: number[];
  /**
   * Precomputed priority boost per skill ID.
   */
  priorityBoostById: number[];
  /**
   * Precompiled name matching regexes per skill ID.
   */
  nameRegexById: Array<{ dollar: RegExp; skillColon: RegExp; word: RegExp }>;
  /**
   * Normalized skill name per skill ID (for O(1) lookups in mention sets).
   */
  normalizedNameById: string[];
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

function buildNameRegex(name: string): { dollar: RegExp; skillColon: RegExp; word: RegExp } {
  if (!name) {
    const never = /$^/;
    return { dollar: never, skillColon: never, word: never };
  }
  const escaped = escapeRegExp(name);
  return {
    dollar: new RegExp(`\\$${escaped}(\\b|$)`, 'i'),
    skillColon: new RegExp(`\\bskill\\s*:\\s*${escaped}(\\b|$)`, 'i'),
    word: new RegExp(`\\b${escaped}\\b`, 'i')
  };
}

function uniqueNormalizedTokens(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const n = normalizeText(v);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function extractExplicitDollarMentions(input: string): Set<string> {
  const out = new Set<string>();
  const re = /\$([\p{L}\p{N}][\p{L}\p{N}_-]*)/giu;
  for (const match of input.matchAll(re)) {
    const raw = match[1];
    if (!raw) continue;
    const name = normalizeText(raw);
    if (name) out.add(name);
  }
  return out;
}

function extractExplicitSkillColonMentions(input: string): Set<string> {
  const out = new Set<string>();
  const re = /\bskill\s*:\s*([\p{L}\p{N}][\p{L}\p{N}_-]*)/giu;
  for (const match of input.matchAll(re)) {
    const raw = match[1];
    if (!raw) continue;
    const name = normalizeText(raw);
    if (name) out.add(name);
  }
  return out;
}

function explicitMentionScore(
  input: string,
  name: string,
  nameRegex: { dollar: RegExp; skillColon: RegExp; word: RegExp },
  explicitDollar: Set<string>,
  explicitSkillColon: Set<string>
): { score: number; reason?: string } {
  if (!name) return { score: 0 };
  if (explicitDollar.has(name) || nameRegex.dollar.test(input)) return { score: 1, reason: 'explicit $skill mention' };
  if (explicitSkillColon.has(name) || nameRegex.skillColon.test(input)) return { score: 1, reason: 'explicit skill:name mention' };
  if (nameRegex.word.test(input)) return { score: 0.65, reason: 'skill name mentioned' };
  return { score: 0 };
}

export class SkillMatcher {
  buildIndex(skills: Skill[]): SkillMatcherIndex {
    const nameToSkillId = new Map<string, number>();
    const tokenToSkillIds = new Map<string, number[]>();
    const keywordDenomById: number[] = [];
    const priorityBoostById: number[] = [];
    const nameRegexById: Array<{ dollar: RegExp; skillColon: RegExp; word: RegExp }> = [];
    const normalizedNameById: string[] = [];

    for (let id = 0; id < skills.length; id += 1) {
      const skill = skills[id]!;
      const name = normalizeText(skill.metadata.name);
      normalizedNameById[id] = name;
      if (name && !nameToSkillId.has(name)) nameToSkillId.set(name, id);

      nameRegexById[id] = buildNameRegex(name);

      const tokens = uniqueNormalizedTokens(skill.metadata.keywordsAll);
      keywordDenomById[id] = Math.min(tokens.length, 12);

      // Priority provides a slight deterministic tiebreaker, not a strong signal.
      priorityBoostById[id] = Math.max(0, Math.min(0.1, (skill.metadata.priority || 0) / 1000));

      for (const token of tokens) {
        const list = tokenToSkillIds.get(token);
        if (list) {
          list.push(id);
        } else {
          tokenToSkillIds.set(token, [id]);
        }
      }
    }

    return {
      skills,
      nameToSkillId,
      tokenToSkillIds,
      keywordDenomById,
      priorityBoostById,
      nameRegexById,
      normalizedNameById
    };
  }

  getCandidateSkillIds(input: string, index: SkillMatcherIndex): number[] {
    const normalized = normalizeText(input);
    if (!normalized) return [];

    const inputTokens = new Set<string>(tokenize(normalized));
    const candidateFlags = new Uint8Array(index.skills.length);
    const candidates: number[] = [];

    for (const token of inputTokens) {
      const ids = index.tokenToSkillIds.get(token);
      if (!ids) continue;
      for (const id of ids) {
        if (!candidateFlags[id]) {
          candidateFlags[id] = 1;
          candidates.push(id);
        }
      }
    }

    for (const token of inputTokens) {
      const id = index.nameToSkillId.get(token);
      if (id === undefined) continue;
      if (!candidateFlags[id]) {
        candidateFlags[id] = 1;
        candidates.push(id);
      }
    }

    const explicitDollar = extractExplicitDollarMentions(normalized);
    const explicitSkillColon = extractExplicitSkillColonMentions(normalized);

    for (const name of explicitDollar) {
      const id = index.nameToSkillId.get(name);
      if (id === undefined) continue;
      if (!candidateFlags[id]) {
        candidateFlags[id] = 1;
        candidates.push(id);
      }
    }

    for (const name of explicitSkillColon) {
      const id = index.nameToSkillId.get(name);
      if (id === undefined) continue;
      if (!candidateFlags[id]) {
        candidateFlags[id] = 1;
        candidates.push(id);
      }
    }

    return candidates;
  }

  match(input: string, skillsOrIndex: Skill[] | SkillMatcherIndex, options?: SkillMatcherOptions): ScoredSkillMatch[] {
    const index = Array.isArray(skillsOrIndex) ? this.buildIndex(skillsOrIndex) : skillsOrIndex;
    const normalized = normalizeText(input);
    const minScore = options?.minScore ?? 0.25;
    const maxResults = options?.maxResults ?? 5;

    const inputTokens = new Set<string>(tokenize(normalized));
    const candidateFlags = new Uint8Array(index.skills.length);
    const overlapCounts = new Uint16Array(index.skills.length);
    const candidateIds: number[] = [];

    for (const token of inputTokens) {
      const ids = index.tokenToSkillIds.get(token);
      if (!ids) continue;
      for (const id of ids) {
        if (!candidateFlags[id]) {
          candidateFlags[id] = 1;
          candidateIds.push(id);
        }
        overlapCounts[id] += 1;
      }
    }

    for (const token of inputTokens) {
      const id = index.nameToSkillId.get(token);
      if (id === undefined) continue;
      if (!candidateFlags[id]) {
        candidateFlags[id] = 1;
        candidateIds.push(id);
      }
    }

    const explicitDollar = extractExplicitDollarMentions(normalized);
    const explicitSkillColon = extractExplicitSkillColonMentions(normalized);

    for (const name of explicitDollar) {
      const id = index.nameToSkillId.get(name);
      if (id === undefined) continue;
      if (!candidateFlags[id]) {
        candidateFlags[id] = 1;
        candidateIds.push(id);
      }
    }

    for (const name of explicitSkillColon) {
      const id = index.nameToSkillId.get(name);
      if (id === undefined) continue;
      if (!candidateFlags[id]) {
        candidateFlags[id] = 1;
        candidateIds.push(id);
      }
    }

    const matches: ScoredSkillMatch[] = [];

    for (const id of candidateIds) {
      const skill = index.skills[id]!;
      const nameScore = explicitMentionScore(
        normalized,
        index.normalizedNameById[id] || normalizeText(skill.metadata.name),
        index.nameRegexById[id]!,
        explicitDollar,
        explicitSkillColon
      );

      const overlap = overlapCounts[id] || 0;
      const denom = index.keywordDenomById[id] || 0;
      const overlapRatio = denom > 0 ? overlap / denom : 0;

      // Base signal from keyword overlap; capped to keep explicit mentions dominant.
      const keywordScore = Math.min(0.8, overlapRatio * 1.2);

      const priorityBoost = index.priorityBoostById[id] || 0;

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
