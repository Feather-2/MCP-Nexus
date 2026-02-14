import type { EventLogger, LoggedEvent } from '../events/EventLogger.js';
import { OrchestratorEvents } from '../orchestrator/OrchestratorEngine.js';

export interface PerformanceMetrics {
  runId: string;
  totalDurationMs: number;
  stepsExecuted: number;
  avgStepDurationMs: number;
  slowestSteps: StepMetric[];
  llmCalls: LlmMetric[];
}

export interface StepMetric {
  stepId: string;
  durationMs: number;
  percentage: number;
}

export interface LlmMetric {
  operation: string;
  model?: string;
  durationMs: number;
  success: boolean;
}

export class PerformanceAnalyzer {
  constructor(private readonly logger: EventLogger) {}

  analyzeByRunId(runId: string): PerformanceMetrics | null {
    if (!this.logger.isEnabled()) return null;

    const events = this.logger.query({ limit: 1000 });
    const runEvents = events.filter((e) => {
      const payload = e.payload as any;
      return payload?.runId === runId;
    });

    if (runEvents.length === 0) return null;

    const executeEnd = runEvents.find((e) => e.type === OrchestratorEvents.EXECUTE_END);
    if (!executeEnd) return null;

    const payload = executeEnd.payload as any;
    const totalDurationMs = payload.durationMs || 0;
    const stepsExecuted = payload.stepsExecuted || 0;

    const stepMetrics = this.extractStepMetrics(runEvents, totalDurationMs);
    const llmMetrics = this.extractLlmMetrics(runEvents);

    return {
      runId,
      totalDurationMs,
      stepsExecuted,
      avgStepDurationMs: stepsExecuted > 0 ? totalDurationMs / stepsExecuted : 0,
      slowestSteps: stepMetrics.slice(0, 5),
      llmCalls: llmMetrics
    };
  }

  private extractStepMetrics(events: LoggedEvent[], totalDurationMs: number): StepMetric[] {
    const stepEnds = events.filter((e) => e.type === OrchestratorEvents.STEP_END);

    const metrics: StepMetric[] = stepEnds.map((e) => {
      const payload = e.payload as any;
      const durationMs = payload.durationMs || 0;
      return {
        stepId: payload.stepId || 'unknown',
        durationMs,
        percentage: totalDurationMs > 0 ? (durationMs / totalDurationMs) * 100 : 0
      };
    });

    return metrics.sort((a, b) => b.durationMs - a.durationMs);
  }

  private extractLlmMetrics(events: LoggedEvent[]): LlmMetric[] {
    // LLM 调用事件通过 AiAuditor 的 onLlmCall 回调发出
    // 这里假设事件类型为 'aiauditor:llm:call'
    const llmEvents = events.filter((e) => e.type === 'aiauditor:llm:call');

    return llmEvents.map((e) => {
      const payload = e.payload as any;
      return {
        operation: payload.operation || 'unknown',
        model: payload.model,
        durationMs: payload.durationMs || 0,
        success: payload.success ?? true
      };
    });
  }

  identifyBottlenecks(runId: string): string[] {
    const metrics = this.analyzeByRunId(runId);
    if (!metrics) return [];

    const bottlenecks: string[] = [];

    // 识别耗时超过 20% 的步骤
    for (const step of metrics.slowestSteps) {
      if (step.percentage > 20) {
        bottlenecks.push(`Step ${step.stepId} took ${step.durationMs}ms (${step.percentage.toFixed(1)}%)`);
      }
    }

    // 识别失败的 LLM 调用
    const failedLlm = metrics.llmCalls.filter((llm) => !llm.success);
    if (failedLlm.length > 0) {
      bottlenecks.push(`${failedLlm.length} LLM calls failed`);
    }

    // 识别慢 LLM 调用（超过 2 秒）
    const slowLlm = metrics.llmCalls.filter((llm) => llm.durationMs > 2000);
    if (slowLlm.length > 0) {
      bottlenecks.push(`${slowLlm.length} LLM calls took >2s`);
    }

    return bottlenecks;
  }
}
