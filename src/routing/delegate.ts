import type { DelegateRequest, DelegateResponse } from './types.js';

export interface SubAgentExecutor {
  execute(department: string, task: string, context?: Record<string, unknown>): Promise<SubAgentResult>;
}

export interface SubAgentResult {
  success: boolean;
  output: string;
  artifacts?: string[];
  error?: string;
}

export interface DelegateToolOptions {
  executor: SubAgentExecutor;
  defaultTimeout?: number;
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
  private readonly onDelegate?: (request: DelegateRequest) => void;
  private readonly onComplete?: (request: DelegateRequest, response: DelegateResponse) => void;
  private readonly memoryStore?: MemoryStore;

  constructor(options: DelegateToolOptions) {
    this.executor = options.executor;
    this.defaultTimeout = options.defaultTimeout ?? 300_000; // 5 minutes
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

    const response: DelegateResponse = {
      status: result.success ? 'success' : 'partial',
      summary: this.summarize(result.output),
      duration
    };

    if (result.artifacts && result.artifacts.length > 0) {
      response.artifacts = result.artifacts;
    }

    // Extract key findings from output
    response.findings = this.extractFindings(result.output);

    // Store detailed results in memory if configured
    if (this.memoryStore) {
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

  private buildErrorResponse(error: unknown, startTime: number): DelegateResponse {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: 'failed',
      summary: `Delegation failed: ${message}`,
      duration
    };
  }

  private summarize(output: string): string {
    // Simple summarization: take first paragraph or first N characters
    const maxLength = 500;

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
        'Delegate a complex task to a specialized SubAgent. Use for tasks requiring multiple steps, external research, or complex analysis.',
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
          }
        },
        required: ['department', 'task']
      }
    };
  }
}
