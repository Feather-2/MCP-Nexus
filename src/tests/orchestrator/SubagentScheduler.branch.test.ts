import { describe, expect, it, vi } from 'vitest';
import { SubagentScheduler, type SchedulerOptions } from '../../orchestrator/SubagentScheduler.js';
import type { Logger } from '../../types/index.js';
import type { OrchestratorStep } from '../../orchestrator/types.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeOpts(overrides?: Partial<SchedulerOptions>): SchedulerOptions {
  return {
    concurrency: { global: 2, perSubagent: 1 },
    defaultStepTimeoutMs: 5000,
    overallTimeoutMs: 30000,
    ...overrides
  };
}

function makeStep(overrides?: Partial<OrchestratorStep>): OrchestratorStep {
  return { template: 'test-tmpl', params: { goal: 'do something' }, ...overrides };
}

describe('SubagentScheduler – branch coverage', () => {
  it('runs steps sequentially by default', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockResolvedValue('ok');
    const results = await sched.run([makeStep(), makeStep()], runner);
    expect(results.length).toBe(2);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('runs steps in parallel when parallel=true', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockResolvedValue('ok');
    const results = await sched.run([makeStep(), makeStep()], runner, { parallel: true });
    expect(results.length).toBe(2);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('retries failed steps up to retries count', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    let callCount = 0;
    const runner = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) throw new Error('transient');
      return Promise.resolve('recovered');
    });
    const step = makeStep({ retries: 2 });
    const results = await sched.run([step], runner);
    expect(results[0].ok).toBe(true);
    expect(results[0].response).toBe('recovered');
  });

  it('returns error after exhausting retries', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockRejectedValue(new Error('permanent'));
    const step = makeStep({ retries: 1 });
    const results = await sched.run([step], runner);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('permanent');
  });

  it('times out individual steps', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts({ defaultStepTimeoutMs: 50 }));
    const runner = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 5000)));
    const results = await sched.run([makeStep()], runner);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('timed out');
  });

  it('respects step-level timeoutMs', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts({ defaultStepTimeoutMs: 60000 }));
    const runner = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 5000)));
    const step = makeStep({ timeoutMs: 50 } as any);
    const results = await sched.run([step], runner);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('timed out');
  });

  it('aborts remaining steps when overall timeout exceeded (sequential)', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts({ overallTimeoutMs: 50 }));
    const runner = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('ok'), 100)));
    const results = await sched.run([makeStep(), makeStep(), makeStep()], runner);
    expect(results.some(r => r.error === 'time budget exceeded')).toBe(true);
  });

  it('handles zero concurrency gracefully', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts({ concurrency: { global: 0, perSubagent: 0 } } as any));
    const runner = vi.fn().mockResolvedValue('ok');
    const results = await sched.run([makeStep()], runner);
    expect(results[0].ok).toBe(true);
  });

  it('uses subagent key for per-subagent semaphore', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockResolvedValue('ok');
    const results = await sched.run([
      makeStep({ subagent: 'agent-a' }),
      makeStep({ subagent: 'agent-b' }),
      makeStep({ subagent: 'agent-a' })
    ], runner, { parallel: true });
    expect(results.length).toBe(3);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('handles runner throwing non-Error', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockImplementation(() => { throw 'string-error'; });
    const results = await sched.run([makeStep()], runner);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('string-error');
  });

  it('records durationMs', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('ok'), 20)));
    const results = await sched.run([makeStep()], runner);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles empty steps array', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn();
    const results = await sched.run([], runner);
    expect(results.length).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });

  it('falls back to template when no subagent', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockResolvedValue('ok');
    const results = await sched.run([makeStep({ subagent: undefined, template: 'my-tmpl' })], runner);
    expect(results[0].ok).toBe(true);
  });

  it('falls back to __default__ when no subagent or template', async () => {
    const sched = new SubagentScheduler(makeLogger(), makeOpts());
    const runner = vi.fn().mockResolvedValue('ok');
    const results = await sched.run([makeStep({ subagent: undefined, template: undefined })], runner);
    expect(results[0].ok).toBe(true);
  });
});
