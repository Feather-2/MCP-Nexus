import { EventLogger } from '../../events/EventLogger.js';
import { PerformanceAnalyzer } from '../../observability/PerformanceAnalyzer.js';
import { OrchestratorEvents } from '../../orchestrator/OrchestratorEngine.js';

describe('PerformanceAnalyzer', () => {
  let logger: EventLogger;
  let analyzer: PerformanceAnalyzer;

  beforeEach(() => {
    logger = new EventLogger({ dbPath: ':memory:' });
    analyzer = new PerformanceAnalyzer(logger);
  });

  afterEach(() => {
    logger.close();
  });

  it('returns null when logger is disabled', () => {
    const disabledLogger = new EventLogger();
    const disabledAnalyzer = new PerformanceAnalyzer(disabledLogger);
    const metrics = disabledAnalyzer.analyzeByRunId('run-1');
    expect(metrics).toBeNull();
  });

  it('analyzes performance by runId', () => {
    logger.log({
      type: OrchestratorEvents.EXECUTE_END,
      payload: { runId: 'run-1', durationMs: 1000, stepsExecuted: 5 }
    });

    const metrics = analyzer.analyzeByRunId('run-1');

    expect(metrics).not.toBeNull();
    expect(metrics!.runId).toBe('run-1');
    expect(metrics!.totalDurationMs).toBe(1000);
    expect(metrics!.stepsExecuted).toBe(5);
    expect(metrics!.avgStepDurationMs).toBe(200);
  });

  it('extracts slowest steps', () => {
    logger.log({
      type: OrchestratorEvents.EXECUTE_END,
      payload: { runId: 'run-1', durationMs: 1000, stepsExecuted: 3 }
    });

    logger.log({
      type: OrchestratorEvents.STEP_END,
      payload: { runId: 'run-1', stepId: 'step-1', durationMs: 100 }
    });

    logger.log({
      type: OrchestratorEvents.STEP_END,
      payload: { runId: 'run-1', stepId: 'step-2', durationMs: 500 }
    });

    logger.log({
      type: OrchestratorEvents.STEP_END,
      payload: { runId: 'run-1', stepId: 'step-3', durationMs: 300 }
    });

    const metrics = analyzer.analyzeByRunId('run-1');

    expect(metrics!.slowestSteps.length).toBe(3);
    expect(metrics!.slowestSteps[0].stepId).toBe('step-2');
    expect(metrics!.slowestSteps[0].durationMs).toBe(500);
    expect(metrics!.slowestSteps[0].percentage).toBe(50);
  });

  it('identifies bottlenecks', () => {
    logger.log({
      type: OrchestratorEvents.EXECUTE_END,
      payload: { runId: 'run-1', durationMs: 1000, stepsExecuted: 2 }
    });

    logger.log({
      type: OrchestratorEvents.STEP_END,
      payload: { runId: 'run-1', stepId: 'step-1', durationMs: 800 }
    });

    logger.log({
      type: OrchestratorEvents.STEP_END,
      payload: { runId: 'run-1', stepId: 'step-2', durationMs: 200 }
    });

    const bottlenecks = analyzer.identifyBottlenecks('run-1');

    expect(bottlenecks.length).toBeGreaterThan(0);
    expect(bottlenecks[0]).toContain('step-1');
    expect(bottlenecks[0]).toContain('800ms');
  });

  it('returns empty bottlenecks when no issues found', () => {
    logger.log({
      type: OrchestratorEvents.EXECUTE_END,
      payload: { runId: 'run-1', durationMs: 1000, stepsExecuted: 5 }
    });

    logger.log({
      type: OrchestratorEvents.STEP_END,
      payload: { runId: 'run-1', stepId: 'step-1', durationMs: 100 }
    });

    const bottlenecks = analyzer.identifyBottlenecks('run-1');

    expect(bottlenecks.length).toBe(0);
  });
});
