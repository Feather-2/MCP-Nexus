import { registerApiVersionAliases, setupApiVersioningCollector } from '../../server/ApiVersioning.js';

describe('ApiVersioning helpers', () => {
  it('collector tracks only non-versioned /api routes', () => {
    const hooks: Record<string, Function> = {};
    const fakeServer = {
      addHook: vi.fn((name: string, fn: Function) => {
        hooks[name] = fn;
      })
    } as any;

    const bucket: Array<Record<string, unknown>> = [];
    setupApiVersioningCollector(fakeServer, 'v1', bucket);
    const onRoute = hooks.onRoute!;

    onRoute({ url: '/api/health' });
    onRoute({ url: '/api/v1/health' });
    onRoute({ url: '/health' });
    onRoute({ url: '/api/logs', config: { __apiVersionAlias: true } });

    expect(bucket).toHaveLength(1);
    expect(bucket[0]?.url).toBe('/api/health');
  });

  it('registers version aliases with __apiVersionAlias marker', () => {
    const route = vi.fn();
    const fakeServer = { route } as any;

    registerApiVersionAliases(fakeServer, 'v1', [{ method: 'GET', url: '/api/health' }]);

    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/api/v1/health',
      config: expect.objectContaining({ __apiVersionAlias: true })
    }));
  });

  it('ignores invalid route entries gracefully', () => {
    const route = vi.fn();
    const fakeServer = { route } as any;

    expect(() => registerApiVersionAliases(fakeServer, 'v1', [{ method: 'GET' } as any])).not.toThrow();
    expect(route).not.toHaveBeenCalled();
  });
});

