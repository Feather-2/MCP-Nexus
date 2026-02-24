import { registerErrorHandlers } from '../../server/ErrorHandlers.js';
import type { Logger } from '../../types/index.js';

function createLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe('ErrorHandlers', () => {
  it('registers error handler and returns unified 500 payload', async () => {
    let errorHandler: any;
    const server = {
      setErrorHandler: vi.fn((fn: any) => {
        errorHandler = fn;
      }),
      setNotFoundHandler: vi.fn()
    } as any;
    const logger = createLogger();
    registerErrorHandlers(server, logger);

    const sent: any[] = [];
    const reply = {
      code: vi.fn(() => reply),
      send: vi.fn((v: any) => {
        sent.push(v);
      })
    } as any;
    const request = { method: 'GET', url: '/boom' } as any;

    await errorHandler(new Error('boom'), request, reply);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(sent[0]).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'INTERNAL_ERROR' })
    }));
    expect(logger.error).toHaveBeenCalledWith('HTTP API error:', expect.objectContaining({ url: '/boom', message: 'boom' }));
  });

  it('registers not-found handler and returns unified 404 payload', async () => {
    let notFoundHandler: any;
    const server = {
      setErrorHandler: vi.fn(),
      setNotFoundHandler: vi.fn((fn: any) => {
        notFoundHandler = fn;
      })
    } as any;
    registerErrorHandlers(server, createLogger());

    const reply = {
      code: vi.fn(() => reply),
      send: vi.fn()
    } as any;
    await notFoundHandler({ method: 'POST', url: '/missing' }, reply);

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        message: 'Route POST /missing not found',
        code: 'NOT_FOUND',
        recoverable: false
      }
    });
  });
});

