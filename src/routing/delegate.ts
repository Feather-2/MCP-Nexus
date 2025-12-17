import type { DelegateRequest, DelegateResponse, ExecutionStep, ReturnMode } from './types.js';

export interface SubAgentExecutor {
  execute(department: string, task: string, context?: Record<string, unknown>): Promise<SubAgentResult>;
}

export interface SubAgentResult {
  success: boolean;
  output: string;
  artifacts?: string[];
  error?: string;
  /** Optional execution steps for detailed tracking */
  steps?: ExecutionStep[];
}

export interface DelegateToolOptions {
  executor: SubAgentExecutor;
  defaultTimeout?: number;
  defaultReturnMode?: ReturnMode;
  onDelegate?: (request: DelegateRequest) => void;
  onComplete?: (request: DelegateRequest, response: DelegateResponse) => void;
  memoryStore?: MemoryStore;
}

export interface MemoryStore {
  store(key: string, value: unknown, tier: 'L0' | 'L1' | 'L2'): Promise<string>;
  retrieve(ref: string): Promise<unknown>;
}

/**
 * DelegateTool provides the interface for delegating complex tasks to SubAgents.
 *
 * Main Agent only sees:
 * - delegate({ department: "research", task: "analyze X" })
 * - Returns summary, not raw data
 * - Tool schemas remain isolated in SubAgent context
 */
export class DelegateTool {
  private readonly executor: SubAgentExecutor;
  private readonly defaultTimeout: number;
  private readonly defaultReturnMode: ReturnMode;
  private readonly onDelegate?: (request: DelegateRequest) => void;
  private readonly onComplete?: (request: DelegateRequest, response: DelegateResponse) => void;
  private readonly memoryStore?: MemoryStore;

  constructor(options: DelegateToolOptions) {
    this.executor = options.executor;
    this.defaultTimeout = options.defaultTimeout ?? 300_000; // 5 minutes
    this.defaultReturnMode = options.defaultReturnMode ?? 'simple';
    this.onDelegate = options.onDelegate;
    this.onComplete = options.onComplete;
    this.memoryStore = options.memoryStore;
  }

  async delegate(request: DelegateRequest): Promise<DelegateResponse> {
    const startTime = Date.now();
    const timeout = request.timeout ?? this.defaultTimeout;

    this.onDelegate?.(request);

    try {
      const result = await this.executeWithTimeout(
        this.executor.execute(request.department, request.task, request.context),
        timeout
      );

      const response = await this.buildResponse(request, result, startTime);
      this.onComplete?.(request, response);

      return response;
    } catch (error) {
      const response = this.buildErrorResponse(error, startTime);
      this.onComplete?.(request, response);
      return response;
    }
  }

  private async executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`SubAgent execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async buildResponse(
    request: DelegateRequest,
    result: SubAgentResult,
    startTime: number
  ): Promise<DelegateResponse> {
    const duration = Date.now() - startTime;
    const returnMode = request.returnMode ?? this.defaultReturnMode;

    // Base response - always includes status, summary, duration
    const response: DelegateResponse = {
      status: result.success ? 'success' : 'partial',
      summary: this.summarize(result.output, returnMode),
      duration
    };

    // Add content based on returnMode
    switch (returnMode) {
      case 'simple':
        // Minimal: just summary (already set)
        break;

      case 'step':
        // Include steps + findings
        if (result.steps && result.steps.length > 0) {
          response.steps = result.steps;
        }
        response.findings = this.extractFindings(result.output);
        if (result.artifacts && result.artifacts.length > 0) {
          response.artifacts = result.artifacts;
        }
        break;

      case 'overview':
        // Include overview summary + findings
        response.overview = this.generateOverview(result, duration);
        response.findings = this.extractFindings(result.output);
        if (result.artifacts && result.artifacts.length > 0) {
          response.artifacts = result.artifacts;
        }
        break;

      case 'details':
        // Full context for debugging
        if (result.steps && result.steps.length > 0) {
          response.steps = result.steps;
        }
        response.overview = this.generateOverview(result, duration);
        response.findings = this.extractFindings(result.output);
        if (result.artifacts && result.artifacts.length > 0) {
          response.artifacts = result.artifacts;
        }
        response.rawOutputs = {
          fullOutput: result.output,
          error: result.error
        };
        break;
    }

    // Store detailed results in memory if configured (for non-simple modes)
    if (this.memoryStore && returnMode !== 'simple') {
      const tier = request.memoryTier ?? 'L1';
      response.memoryRef = await this.memoryStore.store(
        `delegate:${request.department}:${Date.now()}`,
        {
          request,
          result,
          timestamp: new Date().toISOString()
        },
        tier
      );
    }

    return response;
  }

  private generateOverview(result: SubAgentResult, durationMs: number): string {
    const parts: string[] = [];

    // Step count
    if (result.steps && result.steps.length > 0) {
      const successCount = result.steps.filter(s => s.status === 'success').length;
      parts.push(`Executed ${result.steps.length} steps (${successCount} succeeded)`);
    }

    // Duration
    const durationSec = (durationMs / 1000).toFixed(1);
    parts.push(`Duration: ${durationSec}s`);

    // Output size
    const outputSize = result.output.length;
    if (outputSize > 1000) {
      parts.push(`Output: ${(outputSize / 1024).toFixed(1)}KB`);
    }

    // Artifacts
    if (result.artifacts && result.artifacts.length > 0) {
      parts.push(`Artifacts: ${result.artifacts.length}`);
    }

    // Error
    if (result.error) {
      parts.push(`Error: ${result.error.slice(0, 100)}`);
    }

    return parts.join(' | ');
  }

  private buildErrorResponse(error: unknown, startTime: number): DelegateResponse {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: 'failed',
      summary: `Delegation failed: ${message}`,
      duration
    };
  }

  private summarize(output: string, returnMode: ReturnMode): string {
    // Adjust max length based on return mode
    const maxLengths: Record<ReturnMode, number> = {
      simple: 300,
      step: 500,
      overview: 400,
      details: 1000
    };
    const maxLength = maxLengths[returnMode];

    // Try to find a natural break point
    const paragraphs = output.split(/\n\n+/);
    if (paragraphs[0] && paragraphs[0].length <= maxLength) {
      return paragraphs[0].trim();
    }

    // Truncate at sentence boundary if possible
    const truncated = output.slice(0, maxLength);
    const lastSentence = truncated.lastIndexOf('. ');

    if (lastSentence > maxLength * 0.6) {
      return truncated.slice(0, lastSentence + 1).trim();
    }

    return truncated.trim() + '...';
  }

  private extractFindings(output: string): string[] {
    const findings: string[] = [];

    // Look for bullet points
    const bullets = output.match(/(?:^|\n)\s*[-*•]\s+(.+)/g);
    if (bullets) {
      for (const bullet of bullets.slice(0, 5)) {
        const text = bullet.replace(/^[\s\-*•]+/, '').trim();
        if (text.length > 10 && text.length < 200) {
          findings.push(text);
        }
      }
    }

    // Look for numbered items
    if (findings.length < 3) {
      const numbered = output.match(/(?:^|\n)\s*\d+[.)]\s+(.+)/g);
      if (numbered) {
        for (const item of numbered.slice(0, 5 - findings.length)) {
          const text = item.replace(/^[\s\d.)]+/, '').trim();
          if (text.length > 10 && text.length < 200) {
            findings.push(text);
          }
        }
      }
    }

    return findings;
  }

  /**
   * Get tool definition for the delegate tool.
   * This is what the main Agent sees - a simple interface.
   */
  static getToolDefinition(departments: string[]): Record<string, unknown> {
    return {
      name: 'delegate',
      description:
        'Delegate a complex task to a specialized SubAgent. Use for tasks requiring multiple steps, external research, or complex analysis. Returns a summary by default; use returnMode to control detail level.',
      input_schema: {
        type: 'object',
        properties: {
          department: {
            type: 'string',
            enum: departments,
            description: 'The specialized department to handle this task'
          },
          task: {
            type: 'string',
            description: 'Clear description of what needs to be accomplished'
          },
          context: {
            type: 'object',
            description: 'Optional additional context to pass to the SubAgent'
          },
          returnMode: {
            type: 'string',
            enum: ['simple', 'step', 'overview', 'details'],
            default: 'simple',
            description: 'Controls response detail: simple (result only), step (per-step summaries), overview (execution summary), details (full debug info)'
          }
        },
        required: ['department', 'task']
      }
    };
  }
}
