/**
 * Three-tier intelligent routing system types
 *
 * Tiers:
 * - Direct: Simple tasks, tools already in context (read_file, write_file, etc.)
 * - Skills: Medium tasks, load tools on demand via skill triggers
 * - SubAgent: Complex multi-step tasks, fully isolated context, return summaries
 */

export type RoutingTier = 'direct' | 'skills' | 'subagent';

/**
 * Return mode controls how much context is returned to the caller.
 * - simple: Only final result (~100-500 bytes)
 * - step: Each step summary + result (~1-2 KB)
 * - overview: Internal summary + result (~500 bytes - 1 KB)
 * - details: Full context for debugging (~5-50 KB)
 */
export type ReturnMode = 'simple' | 'step' | 'overview' | 'details';

export interface TaskComplexity {
  /** Estimated number of steps required */
  stepCount: number;
  /** Number of different tools likely needed */
  toolCount: number;
  /** Whether task requires multi-file coordination */
  multiFile: boolean;
  /** Whether task requires external API calls */
  externalApi: boolean;
  /** Whether task requires iterative refinement */
  iterative: boolean;
  /** Raw complexity score (0-100) */
  score: number;
}

export interface RoutingDecision {
  tier: RoutingTier;
  confidence: number; // 0-1
  reasoning: string;
  suggestedTools?: string[];
  suggestedSkill?: string;
  suggestedDepartment?: string;
}

export interface ComplexitySignals {
  /** Keywords indicating simple operations */
  simpleKeywords: string[];
  /** Keywords indicating complex operations */
  complexKeywords: string[];
  /** Patterns indicating multi-step tasks */
  multiStepPatterns: RegExp[];
  /** Patterns indicating research/analysis tasks */
  researchPatterns: RegExp[];
}

export interface DelegateRequest {
  /** Target department/domain for the subagent */
  department: string;
  /** Task description */
  task: string;
  /** Optional context to pass to subagent */
  context?: Record<string, unknown>;
  /** Return mode: controls how much detail is returned (default: 'simple') */
  returnMode?: ReturnMode;
  /** Memory tier preference for result storage */
  memoryTier?: 'L0' | 'L1' | 'L2';
  /** Maximum execution time in ms */
  timeout?: number;
}

export interface DelegateResponse {
  /** Execution status */
  status: 'success' | 'partial' | 'failed';
  /** Summary of what was accomplished (always present) */
  summary: string;
  /** Key findings or results (for step/overview/details modes) */
  findings?: string[];
  /** Execution steps (for step/details modes) */
  steps?: ExecutionStep[];
  /** Internal overview (for overview/details modes) */
  overview?: string;
  /** Files created or modified */
  artifacts?: string[];
  /** Raw outputs (for details mode only) */
  rawOutputs?: Record<string, unknown>;
  /** Memory reference for detailed results */
  memoryRef?: string;
  /** Execution duration in ms */
  duration: number;
}

export interface ExecutionStep {
  /** Step identifier or agent name */
  agent: string;
  /** Step status */
  status: 'success' | 'partial' | 'failed' | 'skipped';
  /** Brief summary of what this step did */
  summary: string;
  /** Duration in ms */
  durationMs?: number;
}

export interface SkillTrigger {
  /** Skill identifier */
  skill: string;
  /** Parameters to pass to skill */
  params?: Record<string, unknown>;
}

export interface TierRouterConfig {
  /** Complexity threshold for skills tier (default: 30) */
  skillsThreshold: number;
  /** Complexity threshold for subagent tier (default: 60) */
  subagentThreshold: number;
  /** Tools always available in direct tier */
  directTools: string[];
  /** Available skill categories */
  availableSkills: string[];
  /** Available subagent departments */
  availableDepartments: string[];
}

export const DEFAULT_TIER_CONFIG: TierRouterConfig = {
  skillsThreshold: 30,
  subagentThreshold: 60,
  directTools: [
    'read_file',
    'write_file',
    'list_directory',
    'search_files',
    'run_command'
  ],
  availableSkills: ['search', 'database', 'api', 'transform', 'validate'],
  availableDepartments: ['research', 'coding', 'review', 'testing', 'docs']
};
