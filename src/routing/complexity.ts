import type { ComplexitySignals, TaskComplexity } from './types.js';

const DEFAULT_SIGNALS: ComplexitySignals = {
  simpleKeywords: [
    'read',
    'show',
    'list',
    'get',
    'check',
    'print',
    'display',
    'view',
    'open',
    'cat'
  ],
  complexKeywords: [
    'refactor',
    'migrate',
    'redesign',
    'implement',
    'integrate',
    'optimize',
    'analyze',
    'research',
    'investigate',
    'compare',
    'benchmark',
    'architecture',
    'system',
    'pipeline',
    'workflow'
  ],
  multiStepPatterns: [
    /then\s+(?:also\s+)?/i,
    /after\s+that/i,
    /(?:first|next|finally|lastly)/i,
    /step\s*\d+/i,
    /\d+\.\s+\w+/,
    /and\s+(?:also\s+)?(?:then\s+)?/i,
    /following\s+steps/i,
    /multiple\s+(?:files?|components?|modules?)/i
  ],
  researchPatterns: [
    /how\s+(?:does|do|is|are|can|should)/i,
    /what\s+(?:is|are|does|do)/i,
    /why\s+(?:does|do|is|are)/i,
    /compare\s+(?:and\s+)?(?:contrast)?/i,
    /pros?\s+(?:and\s+)?cons?/i,
    /best\s+(?:practice|approach|way)/i,
    /recommend(?:ation)?/i,
    /(?:find|search|look)\s+(?:for|up)/i
  ]
};

export interface ComplexityEvaluatorOptions {
  signals?: Partial<ComplexitySignals>;
  /** Weight for keyword matching (default: 0.3) */
  keywordWeight?: number;
  /** Weight for pattern matching (default: 0.4) */
  patternWeight?: number;
  /** Weight for length/structure (default: 0.3) */
  structureWeight?: number;
}

export class ComplexityEvaluator {
  private readonly signals: ComplexitySignals;
  private readonly keywordWeight: number;
  private readonly patternWeight: number;
  private readonly structureWeight: number;

  constructor(options?: ComplexityEvaluatorOptions) {
    this.signals = {
      ...DEFAULT_SIGNALS,
      ...options?.signals
    };
    this.keywordWeight = options?.keywordWeight ?? 0.3;
    this.patternWeight = options?.patternWeight ?? 0.4;
    this.structureWeight = options?.structureWeight ?? 0.3;
  }

  evaluate(task: string): TaskComplexity {
    const normalized = task.toLowerCase().trim();

    const keywordScore = this.evaluateKeywords(normalized);
    const patternScore = this.evaluatePatterns(normalized);
    const structureScore = this.evaluateStructure(task);

    const rawScore =
      keywordScore * this.keywordWeight +
      patternScore * this.patternWeight +
      structureScore * this.structureWeight;

    const score = Math.min(100, Math.max(0, Math.round(rawScore)));

    return {
      stepCount: this.estimateStepCount(task),
      toolCount: this.estimateToolCount(normalized),
      multiFile: this.detectMultiFile(normalized),
      externalApi: this.detectExternalApi(normalized),
      iterative: this.detectIterative(normalized),
      score
    };
  }

  private evaluateKeywords(text: string): number {
    let score = 50; // baseline

    const simpleMatches = this.signals.simpleKeywords.filter((kw) =>
      text.includes(kw)
    ).length;

    const complexMatches = this.signals.complexKeywords.filter((kw) =>
      text.includes(kw)
    ).length;

    // Simple keywords reduce complexity
    score -= simpleMatches * 8;
    // Complex keywords increase complexity
    score += complexMatches * 15;

    return Math.min(100, Math.max(0, score));
  }

  private evaluatePatterns(text: string): number {
    let score = 30; // baseline

    const multiStepMatches = this.signals.multiStepPatterns.filter((p) =>
      p.test(text)
    ).length;

    const researchMatches = this.signals.researchPatterns.filter((p) =>
      p.test(text)
    ).length;

    // Multi-step patterns strongly increase complexity
    score += multiStepMatches * 20;
    // Research patterns moderately increase complexity
    score += researchMatches * 12;

    return Math.min(100, Math.max(0, score));
  }

  private evaluateStructure(text: string): number {
    let score = 20; // baseline

    // Length-based scoring
    const wordCount = text.split(/\s+/).length;
    if (wordCount > 50) score += 25;
    else if (wordCount > 20) score += 15;
    else if (wordCount > 10) score += 5;

    // Sentence count
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 5) score += 20;
    else if (sentences.length > 2) score += 10;

    // Bullet points or numbered lists
    const listItems = (text.match(/(?:^|\n)\s*[-*•]\s+/g) || []).length;
    const numberedItems = (text.match(/(?:^|\n)\s*\d+[.)]\s+/g) || []).length;
    score += (listItems + numberedItems) * 8;

    // Code blocks or technical markers
    if (/```/.test(text) || /`[^`]+`/.test(text)) score += 10;

    return Math.min(100, Math.max(0, score));
  }

  private estimateStepCount(text: string): number {
    // Count explicit steps
    const numberedSteps = (text.match(/\d+[.)]\s+/g) || []).length;
    const bulletSteps = (text.match(/(?:^|\n)\s*[-*•]\s+/g) || []).length;
    const explicitSteps = numberedSteps + bulletSteps;

    if (explicitSteps > 0) return explicitSteps;

    // Estimate from conjunctions and sentence structure
    const conjunctions = (
      text.match(/\b(?:then|after|next|finally|also|and then)\b/gi) || []
    ).length;

    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);

    return Math.max(1, conjunctions + Math.ceil(sentences.length / 2));
  }

  private estimateToolCount(text: string): number {
    const toolIndicators = [
      { pattern: /\b(?:read|open|cat|view)\s+(?:file|code)/i, count: 1 },
      { pattern: /\b(?:write|create|save|edit)\s+(?:file|code)/i, count: 1 },
      { pattern: /\b(?:search|find|grep|look\s+for)/i, count: 1 },
      { pattern: /\b(?:run|execute|test|build|compile)/i, count: 1 },
      { pattern: /\b(?:git|commit|push|pull|branch)/i, count: 1 },
      { pattern: /\b(?:api|fetch|request|http)/i, count: 1 },
      { pattern: /\b(?:database|sql|query)/i, count: 1 },
      { pattern: /\b(?:deploy|docker|kubernetes)/i, count: 2 }
    ];

    let count = 0;
    for (const indicator of toolIndicators) {
      if (indicator.pattern.test(text)) {
        count += indicator.count;
      }
    }

    return Math.max(1, count);
  }

  private detectMultiFile(text: string): boolean {
    const multiFilePatterns = [
      /multiple\s+files?/i,
      /several\s+files?/i,
      /all\s+(?:the\s+)?files?/i,
      /across\s+(?:the\s+)?(?:codebase|project|repo)/i,
      /(?:src|lib|components?)\/.*(?:src|lib|components?)\//i,
      /\*\*\/\*\./,
      /refactor/i,
      /rename\s+(?:across|throughout)/i
    ];

    return multiFilePatterns.some((p) => p.test(text));
  }

  private detectExternalApi(text: string): boolean {
    const apiPatterns = [
      /\bapi\b/i,
      /\bhttp[s]?:\/\//i,
      /\bfetch\b/i,
      /\brequest\b/i,
      /\bendpoint\b/i,
      /\bwebhook\b/i,
      /\brest\b/i,
      /\bgraphql\b/i,
      /external\s+service/i
    ];

    return apiPatterns.some((p) => p.test(text));
  }

  private detectIterative(text: string): boolean {
    const iterativePatterns = [
      /\buntil\b/i,
      /\bwhile\b/i,
      /\brepeat\b/i,
      /\bloop\b/i,
      /\beach\b/i,
      /\bevery\b/i,
      /\ball\s+(?:the\s+)?/i,
      /keep\s+(?:trying|going)/i,
      /iterate/i,
      /recursiv/i
    ];

    return iterativePatterns.some((p) => p.test(text));
  }
}
