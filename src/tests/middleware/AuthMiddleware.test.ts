import { AuthMiddleware } from '../../middleware/index.js';
import type { Context, State } from '../../middleware/index.js';

function makeState(): State {
  return { stage: 'beforeAgent', values: new Map<string, unknown>(), aborted: false };
}

function makeCtx(overrides: Partial<Context> = {}): Context {
  return {
    requestId: 'req-1',
    startTime: Date.now(),
    metadata: {},
    ...overrides
  };
}

describe('AuthMiddleware', () => {
  it('does nothing without ctx.http', async () => {
    const authLayer = { authenticate: vi.fn() };
    const mw = new AuthMiddleware(authLayer as any);
    const ctx = makeCtx();
    const state = makeState();

    await mw.beforeAgent?.(ctx, state);
    expect(authLayer.authenticate).not.toHaveBeenCalled();
    expect(state.aborted).toBe(false);
  });

  it('skips when requiresAuth returns false', async () => {
    const authLayer = { authenticate: vi.fn() };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    const request: any = { url: '/api/logs', method: 'GET', ip: '127.0.0.1', headers: {} };
    const ctx = makeCtx({ http: { request, reply } as any });
    const state = makeState();

    const mw = new AuthMiddleware(authLayer as any, { requiresAuth: () => false });
    await mw.beforeAgent?.(ctx, state);
    expect(authLayer.authenticate).not.toHaveBeenCalled();
    expect(state.aborted).toBe(false);
  });

  it('extracts credentials and attaches auth + sessionId on success', async () => {
    const authLayer = {
      authenticate: vi.fn().mockResolvedValue({
        success: true,
        context: { userId: 'u1', permissions: ['*'], trusted: false, mode: 'external-secure' }
      })
    };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    const request: any = {
      url: '/api/logs',
      method: 'GET',
      ip: '1.2.3.4',
      headers: { authorization: 'Bearer t123', apikey: 'k456' }
    };
    const ctx = makeCtx({ http: { request, reply } as any });
    const state = makeState();

    const mw = new AuthMiddleware(authLayer as any);
    await mw.beforeAgent?.(ctx, state);

    expect(authLayer.authenticate).toHaveBeenCalledWith({
      token: 't123',
      apiKey: 'k456',
      clientIp: '1.2.3.4',
      method: 'GET',
      resource: '/api/logs'
    });
    expect((request as any).auth).toMatchObject({ success: true });
    expect(ctx.sessionId).toBe('u1');
    expect(state.aborted).toBe(false);
  });

  it('responds 401 and aborts on failure (default responder)', async () => {
    const authLayer = { authenticate: vi.fn().mockResolvedValue({ success: false, error: 'nope' }) };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    const request: any = { url: '/api/logs', method: 'GET', ip: '1.2.3.4', headers: {} };
    const ctx = makeCtx({ http: { request, reply } as any });
    const state = makeState();

    const mw = new AuthMiddleware(authLayer as any);
    await mw.beforeAgent?.(ctx, state);

    expect(state.aborted).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' })
      })
    );
    expect((request as any).auth).toBeUndefined();
  });

  it('skips auth for /health and /api/health', async () => {
    const authLayer = { authenticate: vi.fn() };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    const requestA: any = { url: '/health', method: 'GET', ip: '127.0.0.1', headers: {} };
    const requestB: any = { url: '/api/health', method: 'GET', ip: '127.0.0.1', headers: {} };

    const mw = new AuthMiddleware(authLayer as any);
    await mw.beforeAgent?.(makeCtx({ http: { request: requestA, reply } as any }), makeState());
    await mw.beforeAgent?.(makeCtx({ http: { request: requestB, reply } as any }), makeState());

    expect(authLayer.authenticate).not.toHaveBeenCalled();
  });
});

