import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin, mockChannelManagerCtor, mockCostTrackerCtor, mockNodeFetchDefault } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockChannelManagerCtor: vi.fn(),
  mockCostTrackerCtor: vi.fn(),
  mockNodeFetchDefault: vi.fn()
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('../../../ai/channel.js', () => ({ ChannelManager: mockChannelManagerCtor }));
vi.mock('../../../ai/cost-tracker.js', () => ({ CostTracker: mockCostTrackerCtor }));
vi.mock('node-fetch', () => ({ default: mockNodeFetchDefault }));

const serviceRegistryStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  getTemplateManager: vi.fn().mockReturnValue({}),
  setInstanceMetadata: vi.fn().mockResolvedValue(undefined)
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
const adaptersStub = {};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({
  ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub)
}));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({
  AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub)
}));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({
  GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub)
}));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({
  ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub)
}));

const baseConfig: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  authMode: 'local-trusted',
  routingStrategy: 'performance',
  loadBalancingStrategy: 'performance-based',
  maxConcurrentServices: 10,
  requestTimeout: 1000,
  enableMetrics: true,
  enableHealthChecks: true,
  healthCheckInterval: 1000,
  maxRetries: 2,
  enableCors: true,
  corsOrigins: ['http://localhost:3000'],
  maxRequestSize: 1024,
  metricsRetentionDays: 1,
  rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
  logLevel: 'info'
};

const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function parseSsePayload(payload: string): any[] {
  return payload
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(5).trim());
    })
    .filter(Boolean);
}

function makeReader(chunks: string[]) {
  const encoder = new TextEncoder();
  let idx = 0;
  return {
    read: vi.fn().mockImplementation(async () => {
      if (idx >= chunks.length) return { value: undefined, done: true };
      const value = encoder.encode(chunks[idx]);
      idx += 1;
      return { value, done: idx >= chunks.length };
    })
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function makeConfigManager(initialAi: any) {
  let aiConfig = initialAi;
  let currentConfig: any = { ...baseConfig, ai: aiConfig };

  const stub = {
    config: { ...baseConfig },
    getConfig: vi.fn().mockImplementation(() => ({ ...currentConfig })),
    get: vi.fn().mockImplementation(async (key: string) => (key === 'ai' ? aiConfig : null)),
    updateConfig: vi.fn().mockImplementation(async (patch: any) => {
      if (patch?.ai !== undefined) aiConfig = patch.ai;
      currentConfig = { ...currentConfig, ...patch, ai: aiConfig };
      stub.config = { ...stub.config, ...patch };
      return { ...currentConfig };
    })
  } as any;

  return {
    stub,
    getAi: () => aiConfig,
    setAi: (next: any) => { aiConfig = next; }
  };
}

const originalEnv = { ...process.env };
let serversToStop: HttpApiServer[] = [];

let lastChannelManager: any;
let lastCostTracker: any;

beforeEach(() => {
  vi.clearAllMocks();

  process.env = { ...originalEnv };
  serversToStop = [];

  lastChannelManager = undefined;
  lastCostTracker = undefined;

  mockChannelManagerCtor.mockReset();
  mockChannelManagerCtor.mockImplementation((config: any) => {
    lastChannelManager = {
      __config: config,
      getAllStates: vi.fn().mockReturnValue([]),
      getState: vi.fn().mockReturnValue(null),
      disableChannel: vi.fn(),
      enableChannel: vi.fn()
    };
    return lastChannelManager;
  });

  mockCostTrackerCtor.mockReset();
  mockCostTrackerCtor.mockImplementation((budget: any) => {
    lastCostTracker = {
      __budget: budget,
      getUsage: vi.fn().mockReturnValue({
        totalCostUsd: 0.01,
        totalPromptTokens: 10,
        totalCompletionTokens: 20,
        budgetUsd: 1,
        budgetRemaining: 0.99,
        periodStart: new Date('2025-01-01T00:00:00.000Z'),
        periodEnd: new Date('2025-01-02T00:00:00.000Z')
      }),
      getUsageByModel: vi.fn().mockReturnValue({ 'gpt-4o-mini': { requests: 1, promptTokens: 10, completionTokens: 20, costUsd: 0.01 } })
    };
    return lastCostTracker;
  });

  mockNodeFetchDefault.mockReset();
  mockNodeFetchDefault.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };

  await Promise.all(
    serversToStop.map(async (srv) => {
      try {
        await srv.stop();
      } catch {
        // best-effort cleanup
      }
    })
  );
});

function makeServer(initialAi: any, overrides?: { getMock?: any }) {
  const configManager = makeConfigManager(initialAi);
  if (overrides?.getMock) {
    configManager.stub.get = overrides.getMock;
  }
  const server = new HttpApiServer(baseConfig, logger, configManager.stub);
  serversToStop.push(server);
  return { server, configManager };
}

describe('AiRoutes', () => {
  describe('GET /api/ai/config', () => {
    it('returns configured AI config', async () => {
      const aiConfig = { provider: 'none', model: '', endpoint: '', timeoutMs: 1000, streaming: true };
      const { server } = makeServer(aiConfig);

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ config: aiConfig });
    });

    it('returns default when AI config missing', async () => {
      const { server } = makeServer(null);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ config: { provider: 'none' } });
    });

    it('returns 500 when config load throws', async () => {
      const getMock = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const { server } = makeServer({ provider: 'none' }, { getMock });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/config' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AI_CONFIG_ERROR');
    });
  });

  describe('PUT /api/ai/config', () => {
    it('validates request body via zod', async () => {
      const { server } = makeServer({ provider: 'none', timeoutMs: 1000 });

      const bad = await (server as any).server.inject({ method: 'PUT', url: '/api/ai/config', payload: { timeoutMs: 'oops' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error?.code).toBe('BAD_REQUEST');

      const ok = await (server as any).server.inject({ method: 'PUT', url: '/api/ai/config', payload: { provider: 'openai', timeoutMs: 1500 } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().success).toBe(true);
      expect(ok.json().config.provider).toBe('openai');
      expect(ok.json().config.timeoutMs).toBe(1500);
    });

    it('returns 500 when updateConfig throws', async () => {
      const aiCfg = { provider: 'none', timeoutMs: 1000 };
      const { server, configManager } = makeServer(aiCfg);
      configManager.stub.updateConfig.mockRejectedValueOnce(new Error('fail update'));

      const res = await (server as any).server.inject({ method: 'PUT', url: '/api/ai/config', payload: { timeoutMs: 2000 } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AI_CONFIG_ERROR');
    });
  });

  describe('POST /api/ai/test', () => {
    it('rejects invalid request body', async () => {
      const { server } = makeServer({ provider: 'none' });
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/ai/test', payload: { mode: 'nope' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
    });

    it('reports missing env vars for OpenAI in env-only mode', async () => {
      delete process.env.OPENAI_API_KEY;
      const { server } = makeServer({ provider: 'openai' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/test',
        payload: { provider: 'openai', endpoint: 'https://api.openai.com', mode: 'env-only' }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.provider).toBe('openai');
      expect(body.env.ok).toBe(false);
      expect(body.env.required).toContain('OPENAI_API_KEY');
    });

    it('skips non-local ping probes', async () => {
      process.env.OPENAI_API_KEY = 'k';
      const { server } = makeServer({ provider: 'openai' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/test',
        payload: { provider: 'openai', endpoint: 'https://example.com', mode: 'ping' }
      });
      const body = res.json();
      expect(body.ping.ok).toBe(false);
      expect(body.ping.note).toContain('Skipping non-local');
      expect(mockNodeFetchDefault).not.toHaveBeenCalled();
    });

    it('pings local ollama endpoint via node-fetch', async () => {
      const { server } = makeServer({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/test',
        payload: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', mode: 'ping' }
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.ping.ok).toBe(true);
      expect(mockNodeFetchDefault).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', { method: 'GET' });
    });

    it('captures ping probe errors', async () => {
      mockNodeFetchDefault.mockRejectedValueOnce(new Error('probe failed'));

      const { server } = makeServer({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/test',
        payload: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', mode: 'ping' }
      });
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.ping.ok).toBe(false);
      expect(body.ping.note).toContain('probe failed');
    });
  });

  describe('POST /api/ai/chat', () => {
    it('validates messages payload', async () => {
      const { server } = makeServer({ provider: 'none' });
      const bad = await (server as any).server.inject({ method: 'POST', url: '/api/ai/chat', payload: { messages: [] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error?.code).toBe('BAD_REQUEST');
    });

    it('returns heuristic fallback when provider is none', async () => {
      const { server } = makeServer({ provider: 'none' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'POST https://example.com/v1/items needs api key' }] }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.provider).toBe('none');
      expect(body.message.content).toContain('# Service Plan');
      expect(body.message.content).toContain('Base URL: https://example.com');
      expect(body.message.content).toContain('Endpoint: POST /v1/items');
      expect(body.message.content).toContain('Auth: API Key header: X-API-Key');
    });

    it('falls back to heuristic when env is missing for configured provider', async () => {
      delete process.env.OPENAI_API_KEY;
      const { server } = makeServer({ provider: 'openai', model: 'gpt-4o-mini' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'GET https://example.com/v1/ping' }] }
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.provider).toBe('openai');
      expect(body.message.content).toContain('# Service Plan');
    });

    it('calls OpenAI when env is present', async () => {
      process.env.OPENAI_API_KEY = 'k-openai';
      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'hello-openai' } }] })
      });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'openai', model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1/chat/completions' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message.content).toBe('hello-openai');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer k-openai'
          })
        })
      );
    });

    it('calls Anthropic when env is present', async () => {
      process.env.ANTHROPIC_API_KEY = 'k-anthropic';
      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ content: [{ text: 'hi' }, { text: '!' }] })
      });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'anthropic', model: 'claude-3-haiku-20240307', endpoint: 'https://api.anthropic.com/v1/messages' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message.content).toBe('hi!');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'k-anthropic',
            'anthropic-version': '2023-06-01'
          })
        })
      );
    });

    it('calls Azure OpenAI when env is present', async () => {
      process.env.AZURE_OPENAI_API_KEY = 'k-azure';
      process.env.AZURE_OPENAI_ENDPOINT = 'https://res.openai.azure.com/';

      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'hello-azure' } }] })
      });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'azure-openai', model: 'deploy-1' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message.content).toBe('hello-azure');
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/openai/deployments/deploy-1/chat/completions?api-version=2024-08-01-preview');
    });

    it('calls Ollama for local provider', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ message: { content: 'hello-ollama' } })
      });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'ollama', model: 'llama3.1:8b', endpoint: 'http://127.0.0.1:11434' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message.content).toBe('hello-ollama');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/chat');
    });

    it('uses default provider branch for non-implemented providers', async () => {
      const { server } = makeServer({ provider: 'google' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'GET https://example.com/v1/ping' }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message.content).toContain('# Service Plan');
    });

    it('returns 500 when provider call throws', async () => {
      process.env.OPENAI_API_KEY = 'k-openai';
      const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'openai' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AI_ERROR');
    });

    it('returns 500 when heuristic plan building fails', async () => {
      const { server } = makeServer({ provider: 'none' });
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { messages: [{ role: 'user', content: 'GET http:///' }] }
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AI_ERROR');
    });
  });

  describe('GET /api/ai/chat/stream (SSE)', () => {
    it('reflects allowed Origin in SSE headers', async () => {
      process.env.OPENAI_API_KEY = 'k-openai';
      const fetchMock = vi.fn().mockResolvedValue({ body: {} });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'openai' });
      const res = await (server as any).server.inject({
        method: 'GET',
        url: '/api/ai/chat/stream?q=hi',
        headers: { origin: 'http://localhost:3000' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res.headers['vary']).toBe('Origin');
    });

    it('streams OpenAI deltas and finishes', async () => {
      process.env.OPENAI_API_KEY = 'k-openai';
      const reader = makeReader([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {not-json}\n',
        'data: [DONE]\n'
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ body: { getReader: () => reader } });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'openai' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=hi' });
      const events = parseSsePayload(res.payload);
      expect(events[0]).toEqual({ event: 'start' });
      expect(events.some((e) => e.event === 'delta' && e.delta === 'Hello')).toBe(true);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('sends error event when streaming provider throws', async () => {
      process.env.OPENAI_API_KEY = 'k-openai';
      const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'openai' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=hi' });
      const events = parseSsePayload(res.payload);
      expect(events[0]).toEqual({ event: 'start' });
      expect(events.some((e) => e.event === 'error')).toBe(true);
    });

    it('streams Azure OpenAI deltas', async () => {
      process.env.AZURE_OPENAI_API_KEY = 'k-azure';
      process.env.AZURE_OPENAI_ENDPOINT = 'https://res.openai.azure.com';

      const reader = makeReader([
        'data: {"choices":[{"delta":{"content":"A"}}]}\n',
        'data: [DONE]\n'
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ body: { getReader: () => reader } });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'azure-openai', model: 'deploy-1' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=hi' });
      const events = parseSsePayload(res.payload);
      expect(events.some((e) => e.event === 'delta' && e.delta === 'A')).toBe(true);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('streams Anthropic deltas', async () => {
      process.env.ANTHROPIC_API_KEY = 'k-anthropic';

      const reader = makeReader([
        'event: message_start\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n',
        'data: not-json\n'
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ body: { getReader: () => reader } });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'anthropic' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=hi' });
      const events = parseSsePayload(res.payload);
      expect(events.some((e) => e.event === 'delta' && e.delta === 'Hi')).toBe(true);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('streams Ollama deltas', async () => {
      const reader = makeReader([
        '{"message":{"content":"1"}}\n',
        'not-json\n',
        '{"message":{"content":"2"}}\n'
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ body: { getReader: () => reader } });
      vi.stubGlobal('fetch', fetchMock);

      const { server } = makeServer({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=hi' });
      const events = parseSsePayload(res.payload);
      expect(events.some((e) => e.event === 'delta' && e.delta === '1')).toBe(true);
      expect(events.some((e) => e.event === 'delta' && e.delta === '2')).toBe(true);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('uses heuristic streaming timer when provider is none', async () => {
      const { server } = makeServer({ provider: 'none' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=GET%20https://example.com/v1/ping' });
      const events = parseSsePayload(res.payload);
      const deltaEvents = events.filter((e) => e.event === 'delta');
      expect(events[0]).toEqual({ event: 'start' });
      expect(deltaEvents.length).toBeGreaterThan(3);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('writes error event when fallback streaming throws', async () => {
      const { server } = makeServer({ provider: 'none' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=GET%20http%3A%2F%2F%2F' });
      const events = parseSsePayload(res.payload);
      expect(events.some((e) => e.event === 'error')).toBe(true);
    });

    it('uses default streaming branch for unknown provider', async () => {
      const { server } = makeServer({ provider: 'google' });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/chat/stream?q=GET%20https://example.com/v1/ping' });
      const events = parseSsePayload(res.payload);
      expect(events.some((e) => e.event === 'delta')).toBe(true);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });
  });

  describe('Channel management and usage', () => {
    const channelA = {
      id: 'ch-a',
      provider: 'openai',
      model: 'gpt-4o-mini',
      keySource: { type: 'literal', value: 'k', format: 'single' },
      weight: 2,
      enabled: true,
      tags: ['primary']
    } as any;

    const channelB = {
      id: 'ch-b',
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      keySource: { type: 'literal', value: 'k2', format: 'single' },
      enabled: false
    } as any;

    it('GET /api/ai/channels returns empty list when no channels configured', async () => {
      const { server } = makeServer({ provider: 'none', channels: [] });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ channels: [], message: 'No channels configured' });
    });

    it('initializes ChannelManager lazily when constructor init failed', async () => {
      const aiCfg = { provider: 'none', channels: [channelA], maxRetries: 7, budget: { maxCostUsd: 1 } };
      const getMock = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error('init fail');
        })
        .mockImplementation(() => aiCfg);

      const { server } = makeServer(aiCfg, { getMock });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels' });
      expect(res.statusCode).toBe(200);
      expect(mockChannelManagerCtor).toHaveBeenCalled();
      expect(mockCostTrackerCtor).toHaveBeenCalledWith(aiCfg.budget);
      expect(lastChannelManager?.__config?.retryAttempts).toBe(7);
    });

    it('GET /api/ai/channels maps channel state when available', async () => {
      const aiCfg = { provider: 'none', channels: [channelA, channelB] };
      const { server } = makeServer(aiCfg);
      await flushMicrotasks();

      const stateA = {
        channelId: 'ch-a',
        enabled: false,
        consecutiveFailures: 2,
        cooldownUntil: new Date('2025-01-01T00:00:00.000Z'),
        metrics: { totalRequests: 10, totalErrors: 1, avgLatencyMs: 123, lastRequestAt: undefined },
        keys: [{ index: 0, enabled: true, errorCount: 1, totalRequests: 10 }]
      };

      lastChannelManager.getAllStates.mockReturnValueOnce([stateA]);

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels' });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.channels).toHaveLength(2);
      expect(body.channels[0].id).toBe('ch-a');
      expect(body.channels[0].enabled).toBe(false);
      expect(body.channels[1].id).toBe('ch-b');
      expect(body.channels[1].enabled).toBe(false);
      expect(body.channels[1].state).toBeNull();
    });

    it('returns 500 when ChannelManager.getAllStates throws', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      await flushMicrotasks();
      lastChannelManager.getAllStates.mockImplementationOnce(() => {
        throw new Error('fail states');
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AI_CHANNELS_ERROR');
    });

    it('GET /api/ai/channels/:id returns 404 when not initialized', async () => {
      const { server } = makeServer({ provider: 'none', channels: [] });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels/ch-a' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error?.code).toBe('NOT_FOUND');
    });

    it('GET /api/ai/channels/:id returns 404 when channel not found', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      await flushMicrotasks();
      lastChannelManager.getState.mockReturnValueOnce(null);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error?.code).toBe('NOT_FOUND');
    });

    it('GET /api/ai/channels/:id returns channel details when present', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      await flushMicrotasks();
      lastChannelManager.getState.mockReturnValueOnce({
        channelId: 'ch-a',
        enabled: true,
        consecutiveFailures: 0,
        cooldownUntil: undefined,
        metrics: { totalRequests: 1, totalErrors: 0, avgLatencyMs: 10, lastRequestAt: undefined },
        keys: [{ index: 0, enabled: true, errorCount: 0, totalRequests: 1 }]
      });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels/ch-a' });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('ch-a');
      expect(res.json().provider).toBe('openai');
    });

    it('POST /api/ai/channels/:id/disable disables channel', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      await flushMicrotasks();
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/ai/channels/ch-a/disable',
        payload: { reason: 'maintenance', durationMs: 1234 }
      });
      expect(res.statusCode).toBe(200);
      expect(lastChannelManager.disableChannel).toHaveBeenCalledWith('ch-a', 'maintenance', 1234);
      expect(res.json()).toEqual({ success: true, id: 'ch-a', enabled: false });
    });

    it('POST /api/ai/channels/:id/enable enables channel', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      await flushMicrotasks();
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/ai/channels/ch-a/enable' });
      expect(res.statusCode).toBe(200);
      expect(lastChannelManager.enableChannel).toHaveBeenCalledWith('ch-a');
      expect(res.json()).toEqual({ success: true, id: 'ch-a', enabled: true });
    });

    it('POST /api/ai/channels validates config body', async () => {
      const aiCfg = { provider: 'none', channels: [] };
      const { server } = makeServer(aiCfg);

      const bad = await (server as any).server.inject({ method: 'POST', url: '/api/ai/channels', payload: { id: '' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error?.code).toBe('BAD_REQUEST');
    });

    it('POST /api/ai/channels rejects duplicate id', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/ai/channels', payload: channelA });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('DUPLICATE_ID');
    });

    it('POST /api/ai/channels adds channel and re-initializes modules', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server, configManager } = makeServer(aiCfg);

      const next = {
        id: 'ch-new',
        provider: 'ollama',
        model: 'llama3.1:8b',
        keySource: { type: 'literal', value: 'k3', format: 'single' }
      };

      const res = await (server as any).server.inject({ method: 'POST', url: '/api/ai/channels', payload: next });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(configManager.getAi().channels).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ch-new' })]));
      expect(mockChannelManagerCtor).toHaveBeenCalled();
      expect(mockCostTrackerCtor).toHaveBeenCalled();
    });

    it('DELETE /api/ai/channels/:id returns 404 when missing', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/ai/channels/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error?.code).toBe('NOT_FOUND');
    });

    it('DELETE /api/ai/channels/:id removes channel', async () => {
      const aiCfg = { provider: 'none', channels: [channelA, channelB] };
      const { server, configManager } = makeServer(aiCfg);
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/ai/channels/ch-b' });
      expect(res.statusCode).toBe(200);
      expect(configManager.getAi().channels.map((c: any) => c.id)).toEqual(['ch-a']);
    });

    it('GET /api/ai/usage returns null when cost tracking not enabled', async () => {
      const { server } = makeServer({ provider: 'none', channels: [] });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/usage' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ usage: null, message: 'Cost tracking not enabled' });
    });

    it('GET /api/ai/usage returns mapped usage and byModel', async () => {
      const aiCfg = { provider: 'none', channels: [channelA], budget: { maxCostUsd: 1 } };
      const { server } = makeServer(aiCfg);

      await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels' });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/usage' });
      expect(res.statusCode).toBe(200);
      expect(res.json().usage.totalCost).toBe(0.01);
      expect(res.json().byModel['gpt-4o-mini'].requests).toBe(1);
    });

    it('GET /api/ai/usage returns 500 when tracker throws', async () => {
      const aiCfg = { provider: 'none', channels: [channelA] };
      const { server } = makeServer(aiCfg);

      await (server as any).server.inject({ method: 'GET', url: '/api/ai/channels' });
      lastCostTracker.getUsage.mockImplementationOnce(() => {
        throw new Error('usage fail');
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/usage' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AI_USAGE_ERROR');
    });
  });
});
