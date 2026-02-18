import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusExporter } from '../../observability/PrometheusExporter.js';
import { EventBus } from '../../events/bus.js';

describe('PrometheusExporter', () => {
  let exporter: PrometheusExporter;
  let eventBus: EventBus;

  beforeEach(() => {
    exporter = new PrometheusExporter();
    eventBus = new EventBus();
    exporter.attachToEventBus(eventBus);
  });

  it('should initialize with empty metrics', async () => {
    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('orchestrator_execute_total 0');
    expect(metrics).toContain('orchestrator_execute_success_total 0');
  });

  it('should track orchestrator execute events', async () => {
    eventBus.publish({
      type: 'orchestrator:execute:start',
      payload: {}
    });

    eventBus.publish({
      type: 'orchestrator:execute:end',
      payload: { success: true, durationMs: 1000 }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('orchestrator_execute_total 1');
    expect(metrics).toContain('orchestrator_execute_success_total 1');
    expect(metrics).toContain('orchestrator_concurrent_executions 0');
  });

  it('should track step errors', async () => {
    eventBus.publish({
      type: 'orchestrator:step:error',
      payload: { error: 'test error' }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('orchestrator_step_error_total 1');
  });

  it('should track EventBus governance events', async () => {
    eventBus.publish({
      type: 'eventbus:backpressure:drop',
      payload: {}
    });

    eventBus.publish({
      type: 'eventbus:buffer:drop',
      payload: {}
    });

    eventBus.publish({
      type: 'eventbus:handler:error',
      payload: {}
    });

    eventBus.publish({
      type: 'eventbus:handler:timeout',
      payload: {}
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('eventbus_backpressure_drops_total 1');
    expect(metrics).toContain('eventbus_buffer_drops_total 1');
    expect(metrics).toContain('eventbus_handler_errors_total 1');
    expect(metrics).toContain('eventbus_handler_timeouts_total 1');
  });

  it('should record LLM calls', async () => {
    exporter.recordLlmCall('gpt-4', 850, true, 1000);
    exporter.recordLlmCall('gpt-4', 900, false, 1200);

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('llm_call_total{model="gpt-4"} 2');
    expect(metrics).toContain('llm_call_success_total 1');
    expect(metrics).toContain('llm_tokens_used_total 2200');
  });

  it('should record errors', async () => {
    exporter.recordError('validation', 'warning', true);
    exporter.recordError('network', 'critical', false);

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('errors_total{category="validation",severity="warning",recoverable="true"} 1');
    expect(metrics).toContain('errors_total{category="network",severity="critical",recoverable="false"} 1');
  });

  it('should track concurrent executions', async () => {
    eventBus.publish({
      type: 'orchestrator:execute:start',
      payload: {}
    });

    eventBus.publish({
      type: 'orchestrator:execute:start',
      payload: {}
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    let metrics = await exporter.getMetrics();
    expect(metrics).toContain('orchestrator_concurrent_executions 2');

    eventBus.publish({
      type: 'orchestrator:execute:end',
      payload: { success: true, durationMs: 500 }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    metrics = await exporter.getMetrics();
    expect(metrics).toContain('orchestrator_concurrent_executions 1');
  });

  it('should record LLM calls via aiauditor:llm:call event', async () => {
    eventBus.publish({
      type: 'aiauditor:llm:call',
      payload: { operation: 'auditSkill', model: 'claude-3', durationMs: 500, success: true, tokensUsed: 800 }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('llm_call_total{model="claude-3"} 1');
    expect(metrics).toContain('llm_call_success_total 1');
    expect(metrics).toContain('llm_tokens_used_total 800');
  });

  it('should record failed LLM call via event', async () => {
    eventBus.publish({
      type: 'aiauditor:llm:call',
      payload: { operation: 'auditSkill', durationMs: 200, success: false, error: 'timeout' }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('llm_call_total{model="unknown"} 1');
    expect(metrics).toContain('llm_call_success_total 0');
  });

  it('should record errors via orchestrator:execute:error event', async () => {
    eventBus.publish({
      type: 'orchestrator:execute:error',
      payload: { error: 'scheduler crashed', stepsCompleted: 2, durationMs: 5000 }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('errors_total{category="orchestrator",severity="critical",recoverable="false"} 1');
  });

  it('should record errors via orchestrator:step:error event', async () => {
    eventBus.publish({
      type: 'orchestrator:step:error',
      payload: { stepId: 'step-1', error: 'tool failed' }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const metrics = await exporter.getMetrics();
    expect(metrics).toContain('orchestrator_step_error_total 1');
    expect(metrics).toContain('errors_total{category="orchestrator",severity="high",recoverable="true"} 1');
  });
});
