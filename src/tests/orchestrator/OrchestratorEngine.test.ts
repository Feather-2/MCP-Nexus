import { OrchestratorEngine } from '../../orchestrator/OrchestratorEngine.js';

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeEngine(opts?: { tools?: string[]; callResult?: any }) {
  const tools = opts?.tools ?? ['search'];
  const callResult = opts?.callResult ?? { ok: true };

  const adapter = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendAndReceive: vi.fn().mockImplementation(async (msg: any) => {
      if (msg?.method === 'tools/list') {
        return { jsonrpc: '2.0', id: msg.id, result: { tools: tools.map((name) => ({ name })) } };
      }
      if (msg?.method === 'tools/call') {
        return { jsonrpc: '2.0', id: msg.id, result: callResult };
      }
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    })
  };

  const protocolAdapters = {
    createAdapter: vi.fn().mockResolvedValue(adapter)
  };

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
      enabled: true,
      mode: 'manager-only',
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

  const logger = makeLogger();
  const engine = new OrchestratorEngine({
    logger: logger as any,
    serviceRegistry: registry as any,
    protocolAdapters: protocolAdapters as any,
    orchestratorManager: orchestratorManager as any,
    subagentLoader: subagentLoader as any
  });

  return { engine, adapter, protocolAdapters, registry, orchestratorManager, subagentLoader, logger };
}

describe('OrchestratorEngine', () => {
  it('executes provided steps with tool resolution and returns results', async () => {
    const { engine, adapter } = makeEngine({ tools: ['search'], callResult: { ok: true, data: 'x' } });

    const res = await engine.execute({
      steps: [{ template: 'brave-search', tool: 'search', params: { query: 'kittens' } }]
    });

    expect(res.success).toBe(true);
    expect(res.plan).toHaveLength(1);
    expect(res.results[0]?.ok).toBe(true);
    expect(res.results[0]?.response).toEqual({ ok: true, data: 'x' });
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(adapter.disconnect).toHaveBeenCalledTimes(1);

    const calls = (adapter.sendAndReceive as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: any) => m?.method === 'tools/list')).toBe(true);
    const toolCall = calls.find((m: any) => m?.method === 'tools/call');
    expect(toolCall?.params?.name).toBe('search');
  });

  it('uses the local planner when only goal is provided', async () => {
    const { engine } = makeEngine({ tools: ['search'], callResult: { ok: true } });

    const res = await engine.execute({ goal: 'search kittens' });
    expect(res.plan).toHaveLength(1);
    expect(res.plan[0]?.template).toBe('brave-search');
    expect(res.plan[0]?.tool).toBe('search');
    expect(res.results[0]?.ok).toBe(true);
  });

  it('auto-picks the first tool when step.tool is omitted', async () => {
    const { engine, adapter } = makeEngine({ tools: ['alpha', 'beta'], callResult: { ok: true } });

    const res = await engine.execute({
      steps: [{ template: 'brave-search', params: { goal: 'do something' } }]
    });

    expect(res.success).toBe(true);
    const calls = (adapter.sendAndReceive as any).mock.calls.map((c: any[]) => c[0]);
    const toolCall = calls.find((m: any) => m?.method === 'tools/call');
    expect(toolCall?.params?.name).toBe('alpha');
  });
});

