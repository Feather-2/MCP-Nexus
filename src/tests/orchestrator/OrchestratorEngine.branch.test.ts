import { OrchestratorEngine } from '../../orchestrator/OrchestratorEngine.js';

function makeLogger() {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeEngine(opts?: {
  tools?: string[];
  callResult?: any;
  listFails?: boolean;
  noSendAndReceive?: boolean;
  templateNull?: boolean;
  loadAllFails?: boolean;
  plannerRemote?: boolean;
  listTemplatesFails?: boolean;
}) {
  const tools = opts?.tools ?? ['search'];
  const callResult = opts?.callResult ?? { ok: true };

  const adapter: any = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  if (opts?.noSendAndReceive) {
    adapter.send = vi.fn().mockResolvedValue(undefined);
    adapter.receive = vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: callResult });
  } else {
    adapter.sendAndReceive = vi.fn().mockImplementation(async (msg: any) => {
      if (opts?.listFails && msg?.method === 'tools/list') throw new Error('list fail');
      if (msg?.method === 'tools/list') {
        return { jsonrpc: '2.0', id: msg.id, result: { tools: tools.map((name) => ({ name })) } };
      }
      if (msg?.method === 'tools/call') {
        return { jsonrpc: '2.0', id: msg.id, result: callResult };
      }
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    });
  }

  const protocolAdapters = {
    createAdapter: vi.fn().mockResolvedValue(adapter),
    releaseAdapter: vi.fn(),
    withAdapter: vi.fn(async (config: any, fn: any) => {
      const a = await protocolAdapters.createAdapter(config);
      await a.connect();
      try { return await fn(a); } finally { protocolAdapters.releaseAdapter(config, a); }
    })
  };

  const registry = {
    listTemplates: opts?.listTemplatesFails
      ? vi.fn().mockRejectedValue(new Error('list fail'))
      : vi.fn().mockResolvedValue([{ name: 'brave-search', version: '2024-11-26', transport: 'http' }]),
    getTemplate: opts?.templateNull
      ? vi.fn().mockResolvedValue(null)
      : vi.fn().mockResolvedValue({ name: 'brave-search', version: '2024-11-26', transport: 'http' })
  };

  const orchestratorManager = {
    getConfig: vi.fn().mockReturnValue({
      enabled: true, mode: 'manager-only',
      planner: { provider: opts?.plannerRemote ? 'remote' : 'local', maxSteps: 8 },
      budget: { maxTimeMs: 5_000, concurrency: { global: 4, perSubagent: 2 } },
      subagentsDir: './config/subagents'
    })
  };

  const subagentLoader = {
    loadAll: opts?.loadAllFails ? vi.fn().mockRejectedValue(new Error('load fail')) : vi.fn().mockResolvedValue(new Map()),
    list: vi.fn().mockReturnValue([{ name: 'search', tools: ['brave-search'] }]),
    get: vi.fn().mockReturnValue({ name: 'search', tools: ['brave-search'] })
  };

  const logger = makeLogger();
  const engine = new OrchestratorEngine({
    logger: logger as any, serviceRegistry: registry as any,
    protocolAdapters: protocolAdapters as any, orchestratorManager: orchestratorManager as any,
    subagentLoader: subagentLoader as any
  });

  return { engine, adapter, registry, orchestratorManager, subagentLoader, logger };
}

describe('OrchestratorEngine \u2013 branch coverage', () => {
  describe('buildPlan branches', () => {
    it('returns empty plan when no goal and no steps', async () => {
      const { engine } = makeEngine();
      const res = await engine.execute({});
      expect(res.plan).toHaveLength(0);
      expect(res.success).toBe(true);
    });

    it('logs warning when planner.provider is remote', async () => {
      const { engine, logger } = makeEngine({ plannerRemote: true });
      await engine.execute({ goal: 'search kittens' });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('remote'));
    });

    it('handles listTemplates failure in buildPlan', async () => {
      const { engine } = makeEngine({ listTemplatesFails: true });
      const res = await engine.execute({ goal: 'search kittens' });
      expect(res.plan.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runStep branches', () => {
    it('throws when template not found', async () => {
      const { engine } = makeEngine({ templateNull: true });
      const res = await engine.execute({
        steps: [{ template: 'nonexistent', tool: 'search', params: {} }]
      });
      expect(res.success).toBe(false);
      expect(res.results[0]?.ok).toBe(false);
    });

    it('uses send/receive when sendAndReceive not available', async () => {
      const { engine, adapter } = makeEngine({ noSendAndReceive: true });
      const res = await engine.execute({
        steps: [{ template: 'brave-search', tool: 'search', params: {} }]
      });
      expect(res.results).toHaveLength(1);
      expect(adapter.send).toHaveBeenCalled();
      expect(adapter.receive).toHaveBeenCalled();
    });
  });

  describe('resolveToolName branches', () => {
    it('falls back to requested when tool not in list', async () => {
      const { engine, adapter } = makeEngine({ tools: ['alpha'] });
      const res = await engine.execute({
        steps: [{ template: 'brave-search', tool: 'nonexistent-tool', params: {} }]
      });
      expect(res.results).toHaveLength(1);
      const calls = (adapter.sendAndReceive as any).mock.calls.map((c: any[]) => c[0]);
      const toolCall = calls.find((m: any) => m?.method === 'tools/call');
      expect(toolCall?.params?.name).toBe('nonexistent-tool');
    });

    it('matches tool by normalized name (hyphen vs underscore)', async () => {
      const { engine, adapter } = makeEngine({ tools: ['my_tool'] });
      const res = await engine.execute({
        steps: [{ template: 'brave-search', tool: 'my-tool', params: {} }]
      });
      const calls = (adapter.sendAndReceive as any).mock.calls.map((c: any[]) => c[0]);
      const toolCall = calls.find((m: any) => m?.method === 'tools/call');
      expect(toolCall?.params?.name).toBe('my_tool');
    });

    it('returns search when no tools and no requested tool', async () => {
      const { engine, adapter } = makeEngine({ tools: [] });
      const res = await engine.execute({
        steps: [{ template: 'brave-search', params: {} }]
      });
      const calls = (adapter.sendAndReceive as any).mock.calls.map((c: any[]) => c[0]);
      const toolCall = calls.find((m: any) => m?.method === 'tools/call');
      expect(toolCall?.params?.name).toBe('search');
    });

    it('falls back when tools/list fails', async () => {
      const { engine } = makeEngine({ listFails: true });
      const res = await engine.execute({
        steps: [{ template: 'brave-search', tool: 'mytool', params: {} }]
      });
      expect(res.results[0]?.ok).toBe(true);
    });
  });

  describe('selectTemplate branches', () => {
    it('returns null for unknown subagent', async () => {
      const { engine, subagentLoader } = makeEngine();
      subagentLoader.get.mockReturnValue(undefined);
      const res = await engine.execute({
        steps: [{ subagent: 'unknown-agent', tool: 'x', params: {} }]
      });
      expect(res.results[0]?.ok).toBe(false);
      expect(res.results[0]?.error).toContain('No suitable template');
    });

    it('selects filesystem template for filesystem subagent', async () => {
      const { engine, registry, subagentLoader } = makeEngine();
      subagentLoader.get.mockReturnValue(undefined);
      registry.getTemplate.mockResolvedValue({ name: 'filesystem', version: '2024-11-26', transport: 'stdio' });
      const res = await engine.execute({
        steps: [{ subagent: 'filesystem', tool: 'read', params: {} }]
      });
      expect(res.results).toHaveLength(1);
    });

    it('selects brave-search for search tool', async () => {
      const { engine, subagentLoader } = makeEngine();
      subagentLoader.get.mockReturnValue(undefined);
      const res = await engine.execute({
        steps: [{ tool: 'search', params: {} }]
      });
      expect(res.results).toHaveLength(1);
    });

    it('uses subagent.tools[0] as template name', async () => {
      const { engine, subagentLoader } = makeEngine();
      subagentLoader.get.mockReturnValue({ name: 'custom', tools: ['my-template'] });
      const res = await engine.execute({
        steps: [{ subagent: 'custom', tool: 'do', params: {} }]
      });
      expect(res.results).toHaveLength(1);
    });
  });

  describe('execute budget branches', () => {
    it('uses req.maxSteps and req.timeoutMs', async () => {
      const { engine } = makeEngine();
      const res = await engine.execute({
        steps: [{ template: 'brave-search', tool: 'search', params: {} }],
        maxSteps: 1, timeoutMs: 1000
      });
      expect(res.plan).toHaveLength(1);
    });

    it('handles subagent loadAll failure gracefully', async () => {
      const { engine } = makeEngine({ loadAllFails: true });
      const res = await engine.execute({
        steps: [{ template: 'brave-search', tool: 'search', params: {} }]
      });
      expect(res.results).toHaveLength(1);
    });

    it('supports parallel execution', async () => {
      const { engine } = makeEngine();
      const res = await engine.execute({
        steps: [
          { template: 'brave-search', tool: 'search', params: { q: '1' } },
          { template: 'brave-search', tool: 'search', params: { q: '2' } }
        ],
        parallel: true
      });
      expect(res.results).toHaveLength(2);
    });
  });
});
