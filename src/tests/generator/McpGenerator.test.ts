import { McpGenerator } from '../../generator/McpGenerator.js';

describe('McpGenerator dry-run modes', () => {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const templateManagerStub = {
    validateTemplate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    register: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null)
  } as any;

  const registryStub = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to schema-only and does not call fetch', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as any);
    // @ts-expect-error - override for test
    globalThis.fetch = fetchSpy;

    try {
      const gen = new McpGenerator({ logger, templateManager: templateManagerStub, registry: registryStub });
      const res = await gen.generate({
        source: { type: 'text', content: 'GET https://example.com/v1/ping' },
        options: { testMode: true, autoRegister: false }
      } as any);

      expect(res.success).toBe(true);
      expect(res.template?.config.transport).toBe('http');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.dryRun?.success).toBe(true);
    } finally {
      // @ts-expect-error - restore
      globalThis.fetch = originalFetch;
    }
  });

  it('uses safe OPTIONS for non-GET endpoints in real mode', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' } as any);
    // @ts-expect-error - override for test
    globalThis.fetch = fetchSpy;

    try {
      const gen = new McpGenerator({ logger, templateManager: templateManagerStub, registry: registryStub });
      const res = await gen.generate({
        source: { type: 'text', content: 'POST https://example.com/v1/items' },
        options: { testMode: true, dryRunMode: 'real', autoRegister: false }
      } as any);

      expect(res.success).toBe(true);
      expect(res.template?.config.transport).toBe('http');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      expect(call?.[0]).toBe('https://example.com/v1/items');
      expect((call?.[1] as any)?.method).toBe('OPTIONS');
      // 404 on OPTIONS is considered acceptable reachability check
      expect(res.dryRun?.success).toBe(true);
    } finally {
      // @ts-expect-error - restore
      globalThis.fetch = originalFetch;
    }
  });
});

