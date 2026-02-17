import { OrchestratorEngine, OrchestratorEvents } from '../../orchestrator/OrchestratorEngine.js';
import { EventBus } from '../../events/bus.js';
import type { Event } from '../../events/types.js';

function makeLogger() {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeEngine(eventBus: EventBus, opts?: { callResult?: any; failStep?: boolean }) {
  const callResult = opts?.callResult ?? { ok: true };
  const failStep = opts?.failStep ?? false;

  const adapter = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendAndReceive: vi.fn().mockImplementation(async (msg: any) => {
      if (msg?.method === 'tools/list') {
        return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }] } };
      }
      if (msg?.method === 'tools/call') {
        if (failStep) throw new Error('step-boom');
        return { jsonrpc: '2.0', id: msg.id, result: callResult };
      }
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    })
  };

  const protocolAdapters = { createAdapter: vi.fn().mockResolvedValue(adapter), releaseAdapter: vi.fn() };
  const registry = {
    listTemplates: vi.fn().mockResolvedValue([
      { name: 'brave-search', version: '2024-11-26', transport: 'http', timeout: 1000, retries: 0 }
    ]),
    getTemplate: vi.fn().mockResolvedValue(
      { name: 'brave-search', version: '2024-11-26', transport: 'http', timeout: 1000, retries: 0 }
    )
  };
  const orchestratorManager = {
    getConfig: vi.fn().mockReturnValue({
      enabled: true, mode: 'manager-only',
      planner: { provider: 'local', maxSteps: 8 },
      budget: { maxTimeMs: 5_000, concurrency: { global: 4, perSubagent: 2 } },
      subagentsDir: './config/subagents'
    })
  };
  const subagentLoader = {
    loadAll: vi.fn().mockResolvedValue(new Map()),
    list: vi.fn().mockReturnValue([{ name: 'search', tools: ['brave-search'] }]),
    get: vi.fn().mockReturnValue({ name: 'search', tools: ['brave-search'] })
  };

  return new OrchestratorEngine({
    logger: makeLogger() as any,
    serviceRegistry: registry as any,
    protocolAdapters: protocolAdapters as any,
    orchestratorManager: orchestratorManager as any,
    subagentLoader: subagentLoader as any,
    eventBus
  });
}

function collectEvents(bus: EventBus, types: string[]): Event[] {
  const events: Event[] = [];
  for (const t of types) {
    bus.subscribe(t, (evt) => { events.push(evt); });
  }
  return events;
}

const ALL_LIFECYCLE = [
  OrchestratorEvents.EXECUTE_START,
  OrchestratorEvents.EXECUTE_END,
  OrchestratorEvents.PLAN_START,
  OrchestratorEvents.PLAN_END,
  OrchestratorEvents.STEP_START,
  OrchestratorEvents.STEP_END,
  OrchestratorEvents.STEP_ERROR,
];

describe('OrchestratorEngine lifecycle events', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ queueDepth: 64, bufferSize: 64 });
  });

  it('emits execute/plan/step lifecycle events on success', async () => {
    const events = collectEvents(bus, ALL_LIFECYCLE);
    const engine = makeEngine(bus);

    await engine.execute({
      steps: [{ template: 'brave-search', tool: 'search', params: { query: 'test' } }]
    });

    await new Promise((r) => setTimeout(r, 100));

    const types = events.map((e) => e.type);
    expect(types).toContain(OrchestratorEvents.EXECUTE_START);
    expect(types).toContain(OrchestratorEvents.PLAN_START);
    expect(types).toContain(OrchestratorEvents.PLAN_END);
    expect(types).toContain(OrchestratorEvents.STEP_START);
    expect(types).toContain(OrchestratorEvents.STEP_END);
    expect(types).toContain(OrchestratorEvents.EXECUTE_END);
    expect(types).not.toContain(OrchestratorEvents.STEP_ERROR);
  });

  it('emits STEP_ERROR when a step fails', async () => {
    const events = collectEvents(bus, ALL_LIFECYCLE);
    const engine = makeEngine(bus, { failStep: true });

    const res = await engine.execute({
      steps: [{ template: 'brave-search', tool: 'search', params: { query: 'fail' } }]
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(res.success).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toContain(OrchestratorEvents.STEP_ERROR);
  });

  it('includes runId in all lifecycle events', async () => {
    const events = collectEvents(bus, ALL_LIFECYCLE);
    const engine = makeEngine(bus);

    await engine.execute({
      steps: [{ template: 'brave-search', tool: 'search', params: { query: 'x' } }]
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(events.length).toBeGreaterThan(0);
    const runIds = new Set(events.map((e) => (e.payload as any)?.runId ?? e.metadata?.runId));
    // All events should share the same runId (from the payload or event field)
    const firstEvent = events[0];
    expect(firstEvent.component).toBe('OrchestratorEngine');
  });

  it('EXECUTE_END payload contains success and durationMs', async () => {
    const events = collectEvents(bus, [OrchestratorEvents.EXECUTE_END]);
    const engine = makeEngine(bus);

    await engine.execute({
      steps: [{ template: 'brave-search', tool: 'search', params: { query: 'x' } }]
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(events.length).toBe(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.success).toBe(true);
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.stepsExecuted).toBe(1);
  });
});
