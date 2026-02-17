import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { EventBus } from '../events/bus.js';

export class PrometheusExporter {
  private registry: Registry;
  private executeSuccess: Counter;
  private executeTotal: Counter;
  private executeDuration: Histogram;
  private stepError: Counter;
  private concurrentExecutions: Gauge;
  private eventbusPublished: Counter;
  private eventbusBackpressureDrops: Counter;
  private eventbusBufferDrops: Counter;
  private eventbusHandlerErrors: Counter;
  private eventbusHandlerTimeouts: Counter;
  private llmCallSuccess: Counter;
  private llmCallTotal: Counter;
  private llmCallDuration: Histogram;
  private llmTokensUsed: Counter;
  private errorsTotal: Counter;

  constructor() {
    this.registry = new Registry();

    this.executeSuccess = new Counter({
      name: 'orchestrator_execute_success_total',
      help: 'Total successful executions',
      registers: [this.registry],
    });

    this.executeTotal = new Counter({
      name: 'orchestrator_execute_total',
      help: 'Total executions',
      registers: [this.registry],
    });

    this.executeDuration = new Histogram({
      name: 'orchestrator_execute_duration_ms',
      help: 'Execution duration in milliseconds',
      buckets: [100, 500, 1000, 2000, 5000, 10000],
      registers: [this.registry],
    });

    this.stepError = new Counter({
      name: 'orchestrator_step_error_total',
      help: 'Total step errors',
      registers: [this.registry],
    });

    this.concurrentExecutions = new Gauge({
      name: 'orchestrator_concurrent_executions',
      help: 'Current concurrent executions',
      registers: [this.registry],
    });

    this.eventbusPublished = new Counter({
      name: 'eventbus_published_total',
      help: 'Total events published',
      registers: [this.registry],
    });

    this.eventbusBackpressureDrops = new Counter({
      name: 'eventbus_backpressure_drops_total',
      help: 'Total backpressure drops',
      registers: [this.registry],
    });

    this.eventbusBufferDrops = new Counter({
      name: 'eventbus_buffer_drops_total',
      help: 'Total buffer drops',
      registers: [this.registry],
    });

    this.eventbusHandlerErrors = new Counter({
      name: 'eventbus_handler_errors_total',
      help: 'Total handler errors',
      registers: [this.registry],
    });

    this.eventbusHandlerTimeouts = new Counter({
      name: 'eventbus_handler_timeouts_total',
      help: 'Total handler timeouts',
      registers: [this.registry],
    });

    this.llmCallSuccess = new Counter({
      name: 'llm_call_success_total',
      help: 'Total successful LLM calls',
      registers: [this.registry],
    });

    this.llmCallTotal = new Counter({
      name: 'llm_call_total',
      help: 'Total LLM calls',
      labelNames: ['model'],
      registers: [this.registry],
    });

    this.llmCallDuration = new Histogram({
      name: 'llm_call_duration_ms',
      help: 'LLM call duration in milliseconds',
      buckets: [100, 500, 1000, 2000, 5000, 10000],
      registers: [this.registry],
    });

    this.llmTokensUsed = new Counter({
      name: 'llm_tokens_used_total',
      help: 'Total tokens used',
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: 'errors_total',
      help: 'Total errors',
      labelNames: ['category', 'severity', 'recoverable'],
      registers: [this.registry],
    });
  }

  attachToEventBus(eventBus: EventBus): void {
    eventBus.subscribe('orchestrator:execute:start', () => {
      this.concurrentExecutions.inc();
    });

    eventBus.subscribe('orchestrator:execute:end', (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      this.executeTotal.inc();
      if (payload?.success) this.executeSuccess.inc();
      if (payload?.durationMs) this.executeDuration.observe(payload.durationMs as number);
      this.concurrentExecutions.dec();
    });

    eventBus.subscribe('orchestrator:step:error', () => {
      this.stepError.inc();
    });

    eventBus.subscribe('eventbus:backpressure:drop', () => {
      this.eventbusBackpressureDrops.inc();
    });

    eventBus.subscribe('eventbus:buffer:drop', () => {
      this.eventbusBufferDrops.inc();
    });

    eventBus.subscribe('eventbus:handler:error', () => {
      this.eventbusHandlerErrors.inc();
    });

    eventBus.subscribe('eventbus:handler:timeout', () => {
      this.eventbusHandlerTimeouts.inc();
    });
  }

  recordLlmCall(model: string, durationMs: number, success: boolean, tokensUsed?: number): void {
    this.llmCallTotal.inc({ model });
    if (success) this.llmCallSuccess.inc();
    this.llmCallDuration.observe(durationMs);
    if (tokensUsed) this.llmTokensUsed.inc(tokensUsed);
  }

  recordError(category: string, severity: string, recoverable: boolean): void {
    this.errorsTotal.inc({ category, severity, recoverable: String(recoverable) });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getRegistry(): Registry {
    return this.registry;
  }
}
