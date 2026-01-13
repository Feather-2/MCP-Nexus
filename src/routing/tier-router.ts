import { ComplexityEvaluator } from './complexity.js';
import type {
  RoutingDecision,
  RoutingTier,
  TaskComplexity,
  TierRouterConfig
} from './types.js';

export interface TierRouterOptions {
  config?: Partial<TierRouterConfig>;
  evaluator?: ComplexityEvaluator;
}

export class TierRouter {
  private readonly config: TierRouterConfig;
  private readonly evaluator: ComplexityEvaluator;

  constructor(options?: TierRouterOptions) {
    this.config = {
      skillsThreshold: options?.config?.skillsThreshold ?? 30,
      subagentThreshold: options?.config?.subagentThreshold ?? 60,
      directTools: options?.config?.directTools ?? [
        'read_file',
        'write_file',
        'list_directory',
        'search_files',
        'run_command'
      ],
      availableSkills: options?.config?.availableSkills ?? [
        'search',
        'database',
        'api',
        'transform',
        'validate'
      ],
      availableDepartments: options?.config?.availableDepartments ?? [
        'research',
        'coding',
        'review',
        'testing',
        'docs'
      ]
    };
    this.evaluator = options?.evaluator ?? new ComplexityEvaluator();
  }

  route(task: string): RoutingDecision {
    const complexity = this.evaluator.evaluate(task);
    const tier = this.determineTier(complexity);
    const confidence = this.calculateConfidence(complexity, tier);

    const decision: RoutingDecision = {
      tier,
      confidence,
      reasoning: this.generateReasoning(complexity, tier)
    };

    // Add tier-specific suggestions
    if (tier === 'direct') {
      decision.suggestedTools = this.suggestDirectTools(task);
    } else if (tier === 'skills') {
      decision.suggestedSkill = this.suggestSkill(task);
    } else {
      decision.suggestedDepartment = this.suggestDepartment(task);
    }

    return decision;
  }

  routeWithComplexity(task: string): { decision: RoutingDecision; complexity: TaskComplexity } {
    const complexity = this.evaluator.evaluate(task);
    const tier = this.determineTier(complexity);
    const confidence = this.calculateConfidence(complexity, tier);

    const decision: RoutingDecision = {
      tier,
      confidence,
      reasoning: this.generateReasoning(complexity, tier)
    };

    if (tier === 'direct') {
      decision.suggestedTools = this.suggestDirectTools(task);
    } else if (tier === 'skills') {
      decision.suggestedSkill = this.suggestSkill(task);
    } else {
      decision.suggestedDepartment = this.suggestDepartment(task);
    }

    return { decision, complexity };
  }

  private determineTier(complexity: TaskComplexity): RoutingTier {
    // Hard rules that override score-based routing
    if (complexity.multiFile && complexity.stepCount > 3) {
      return 'subagent';
    }

    if (complexity.externalApi && complexity.iterative) {
      return 'subagent';
    }

    // Score-based routing
    if (complexity.score >= this.config.subagentThreshold) {
      return 'subagent';
    }

    if (complexity.score >= this.config.skillsThreshold) {
      return 'skills';
    }

    return 'direct';
  }

  private calculateConfidence(complexity: TaskComplexity, tier: RoutingTier): number {
    const score = complexity.score;
    const skillsThreshold = this.config.skillsThreshold;
    const subagentThreshold = this.config.subagentThreshold;

    // Calculate distance from thresholds
    let confidence: number;

    if (tier === 'direct') {
      // Confidence increases as score moves away from skillsThreshold
      const distance = skillsThreshold - score;
      confidence = Math.min(1, 0.5 + distance / (skillsThreshold * 2));
    } else if (tier === 'skills') {
      // Confidence is highest in the middle of the skills range
      const rangeSize = subagentThreshold - skillsThreshold;
      const midpoint = skillsThreshold + rangeSize / 2;
      const distanceFromMid = Math.abs(score - midpoint);
      confidence = Math.max(0.5, 1 - distanceFromMid / rangeSize);
    } else {
      // subagent: confidence increases as score exceeds threshold
      const excess = score - subagentThreshold;
      confidence = Math.min(1, 0.6 + excess / (100 - subagentThreshold));
    }

    // Boost confidence for clear signals
    if (tier === 'subagent' && complexity.multiFile) {
      confidence = Math.min(1, confidence + 0.1);
    }

    return Math.round(confidence * 100) / 100;
  }

  private generateReasoning(complexity: TaskComplexity, tier: RoutingTier): string {
    const factors: string[] = [];

    factors.push(`complexity score: ${complexity.score}`);

    if (complexity.stepCount > 1) {
      factors.push(`~${complexity.stepCount} steps`);
    }

    if (complexity.toolCount > 1) {
      factors.push(`~${complexity.toolCount} tools`);
    }

    if (complexity.multiFile) {
      factors.push('multi-file');
    }

    if (complexity.externalApi) {
      factors.push('external API');
    }

    if (complexity.iterative) {
      factors.push('iterative');
    }

    const tierExplanation = {
      direct: 'simple task, handle directly',
      skills: 'medium complexity, use skill',
      subagent: 'complex task, delegate to subagent'
    };

    return `${tierExplanation[tier]} (${factors.join(', ')})`;
  }

  private suggestDirectTools(task: string): string[] {
    const text = task.toLowerCase();
    const suggested: string[] = [];

    const toolPatterns: Array<{ pattern: RegExp; tool: string }> = [
      { pattern: /\b(?:read|open|cat|view|show)\b/, tool: 'read_file' },
      { pattern: /\b(?:write|create|save|edit|modify)\b/, tool: 'write_file' },
      { pattern: /\b(?:list|ls|dir|files?|folder)\b/, tool: 'list_directory' },
      { pattern: /\b(?:search|find|grep|look)\b/, tool: 'search_files' },
      { pattern: /\b(?:run|execute|command|shell|bash)\b/, tool: 'run_command' }
    ];

    for (const { pattern, tool } of toolPatterns) {
      if (pattern.test(text) && this.config.directTools.includes(tool)) {
        suggested.push(tool);
      }
    }

    // Default to read_file if nothing matches
    if (suggested.length === 0) {
      suggested.push('read_file');
    }

    return [...new Set(suggested)];
  }

  private suggestSkill(task: string): string {
    const text = task.toLowerCase();

    const skillPatterns: Array<{ pattern: RegExp; skill: string }> = [
      { pattern: /\b(?:search|find|query|lookup)\b/, skill: 'search' },
      { pattern: /\b(?:database|sql|table|record)\b/, skill: 'database' },
      { pattern: /\b(?:api|http|fetch|request|endpoint)\b/, skill: 'api' },
      { pattern: /\b(?:transform|convert|parse|format)\b/, skill: 'transform' },
      { pattern: /\b(?:validate|check|verify|lint)\b/, skill: 'validate' }
    ];

    for (const { pattern, skill } of skillPatterns) {
      if (pattern.test(text) && this.config.availableSkills.includes(skill)) {
        return skill;
      }
    }

    // Default skill
    return this.config.availableSkills[0] ?? 'search';
  }

  private suggestDepartment(task: string): string {
    const text = task.toLowerCase();

    const deptPatterns: Array<{ pattern: RegExp; dept: string }> = [
      { pattern: /\b(?:research|investigate|analyze|study|compare)\b/, dept: 'research' },
      { pattern: /\b(?:implement|code|develop|build|create|write)\b/, dept: 'coding' },
      { pattern: /\b(?:review|audit|inspect|check)\b/, dept: 'review' },
      { pattern: /\b(?:test|spec|coverage|unit|integration)\b/, dept: 'testing' },
      { pattern: /\b(?:doc|readme|comment|explain|describe)\b/, dept: 'docs' }
    ];

    for (const { pattern, dept } of deptPatterns) {
      if (
        pattern.test(text) &&
        this.config.availableDepartments.includes(dept)
      ) {
        return dept;
      }
    }

    // Default department based on complexity signals
    return this.config.availableDepartments[0] ?? 'research';
  }
}
