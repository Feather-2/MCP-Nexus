export type SkillScope = 'repo' | 'user' | 'system' | 'remote';

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  /**
   * Absolute path to the SKILL.md file on the Nexus host.
   * This is primarily for debugging/ops; clients should not rely on it.
   */
  path: string;
  scope: SkillScope;
  /**
   * Keywords explicitly provided by the skill author.
   */
  keywords: string[];
  /**
   * Expanded keyword set derived from name/description/tags/traits.
   */
  keywordsAll: string[];
  /**
   * Comma/space separated list of tool IDs this skill intends to use (e.g. "filesystem, brave-search").
   * Audited against templates + sandbox policy.
   */
  allowedTools?: string;
  tags?: Record<string, string>;
  traits?: string[];
  priority: number;
}

export interface Skill {
  metadata: SkillMetadata;
  body: string;
  /**
   * Optional bundled support files (text only) keyed by relative path.
   * This is loaded on-demand to keep memory footprint small.
   */
  supportFiles?: Map<string, string>;
}

export interface MatchResult {
  matched: boolean;
  score: number; // 0-1
  reason: string;
}

export interface AuditResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  dryRunResults?: {
    tool: string;
    success: boolean;
    latency: number;
    error?: string;
  }[];
}

