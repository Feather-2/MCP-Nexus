import path from 'path';
import { ProtocolAdaptersImpl } from '../../adapters/ProtocolAdaptersImpl.js';
import { ContainerTransportAdapter } from '../../adapters/ContainerTransportAdapter.js';
import { HttpTransportAdapter } from '../../adapters/HttpTransportAdapter.js';
import { StreamableHttpAdapter } from '../../adapters/StreamableHttpAdapter.js';
import { StdioTransportAdapter } from '../../adapters/StdioTransportAdapter.js';
import type { Logger, McpServiceConfig, TransportAdapter } from '../../types/index.js';

function makeLogger(overrides?: Partial<Logger>): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides
  };
}

function makeBaseConfig(overrides?: Partial<McpServiceConfig>): McpServiceConfig {
  return {
    name: 'test-svc',
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['-e', 'console.log("ok")'],
    env: {},
    timeout: 1000,
    retries: 0,
    ...overrides
  };
}

describe('ProtocolAdaptersImpl', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('detectProtocol', () => {
    it('returns streamable-http when endpoint responds with text/event-stream', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        headers: { get: vi.fn().mockReturnValue('text/event-stream; charset=utf-8') }
      });
      vi.stubGlobal('fetch', fetchMock);

      const logger = makeLogger();
      const adapters = new ProtocolAdaptersImpl(logger);

      await expect(adapters.detectProtocol('http://example.test')).resolves.toBe('streamable-http');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://example.test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache'
          })
        })
      );
    });

    it('returns http when endpoint is http(s) but not SSE', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        headers: { get: vi.fn().mockReturnValue('application/json') }
      });
      vi.stubGlobal('fetch', fetchMock);

      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.detectProtocol('https://example.test')).resolves.toBe('http');
    });

    it('returns http when probing SSE fails (network error / invalid URL)', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetchMock);

      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.detectProtocol('http://invalid-url')).resolves.toBe('http');
    });

    it('defaults to stdio when endpoint is not http(s)', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.detectProtocol('node ./server.js')).resolves.toBe('stdio');
    });
  });

  describe('validateProtocol', () => {
    it('returns true for a valid MCP response (result)', async () => {
      const logger = makeLogger();
      const adapters = new ProtocolAdaptersImpl(logger);

      const adapter: Pick<TransportAdapter, 'connect' | 'send' | 'receive' | 'disconnect'> = {
        connect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', result: { ok: true } }),
        disconnect: vi.fn().mockResolvedValue(undefined)
      };

      await expect(adapters.validateProtocol(adapter as any, '2024-11-26')).resolves.toBe(true);

      expect(adapter.connect).toHaveBeenCalledTimes(1);
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 'protocol-test',
          method: 'initialize',
          params: expect.objectContaining({ protocolVersion: '2024-11-26' })
        })
      );
      expect(adapter.receive).toHaveBeenCalledTimes(1);
      expect(adapter.disconnect).toHaveBeenCalledTimes(1);
    });

    it('returns true for a valid MCP response (error)', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter: Pick<TransportAdapter, 'connect' | 'send' | 'receive' | 'disconnect'> = {
        connect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } }),
        disconnect: vi.fn().mockResolvedValue(undefined)
      };

      await expect(adapters.validateProtocol(adapter as any, '2025-03-26')).resolves.toBe(true);
    });

    it('returns false for non-response JSON-RPC shapes (request/notification)', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter: Pick<TransportAdapter, 'connect' | 'send' | 'receive' | 'disconnect'> = {
        connect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        disconnect: vi.fn().mockResolvedValue(undefined)
      };

      await expect(adapters.validateProtocol(adapter as any, '2024-11-26')).resolves.toBe(false);
    });

    it('returns false and logs when adapter throws', async () => {
      const logger = makeLogger();
      const adapters = new ProtocolAdaptersImpl(logger);

      const adapter: Pick<TransportAdapter, 'connect' | 'send' | 'receive' | 'disconnect'> = {
        connect: vi.fn().mockRejectedValue(new Error('connect failed')),
        send: vi.fn(),
        receive: vi.fn(),
        disconnect: vi.fn()
      };

      await expect(adapters.validateProtocol(adapter as any, '2024-11-26')).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith('Protocol validation failed:', expect.any(Error));
    });

    it('returns false on protocol validation timeout', async () => {
      vi.useFakeTimers();

      const logger = makeLogger();
      const adapters = new ProtocolAdaptersImpl(logger);

      const adapter: Pick<TransportAdapter, 'connect' | 'send' | 'receive' | 'disconnect'> = {
        connect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn(() => new Promise(() => { /* never resolves */ })),
        disconnect: vi.fn().mockResolvedValue(undefined)
      };

      const promise = adapters.validateProtocol(adapter as any, '2024-11-26');
      await vi.advanceTimersByTimeAsync(5000);

      await expect(promise).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith('Protocol validation failed:', expect.any(Error));
      expect(adapter.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('createAdapter', () => {
    it('creates a stdio adapter by default for stdio transport', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter = await adapters.createAdapter(makeBaseConfig({ transport: 'stdio' }));
      expect(adapter).toBeInstanceOf(StdioTransportAdapter);
    });

    it('creates an HTTP adapter for http transport', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter = await adapters.createAdapter(makeBaseConfig({ transport: 'http', command: 'http://example.test' }));
      expect(adapter).toBeInstanceOf(HttpTransportAdapter);
    });

    it('creates a Streamable HTTP adapter for streamable-http transport', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter = await adapters.createAdapter(makeBaseConfig({ transport: 'streamable-http', command: 'http://example.test' }));
      expect(adapter).toBeInstanceOf(StreamableHttpAdapter);
    });

    it('creates a container adapter when container config is present and passes sandbox policy hints', async () => {
      const logger = makeLogger();
      const gatewayConfig = {
        sandbox: {
          container: {
            allowedVolumeRoots: ['./data'],
            envSafePrefixes: ['FOO_'],
            defaultNetwork: 'bridge',
            defaultReadonlyRootfs: false
          }
        }
      } as any;

      const adapters = new ProtocolAdaptersImpl(logger, () => gatewayConfig);

      const adapter = await adapters.createAdapter(makeBaseConfig({
        transport: 'stdio',
        container: { image: 'node:20-alpine' } as any
      }));

      expect(adapter).toBeInstanceOf(ContainerTransportAdapter);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Creating container-stdio adapter'));

      const policy = (adapter as any).policy;
      expect(policy).toEqual(expect.objectContaining({
        defaultNetwork: 'bridge',
        defaultReadonlyRootfs: false,
        envSafePrefixes: ['FOO_'],
        allowedVolumeRoots: [path.resolve(process.cwd(), './data')]
      }));
    });

    it('throws for unsupported transport types', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());

      await expect(adapters.createAdapter(makeBaseConfig({ transport: 'nope' as any }))).rejects.toThrow(
        'Unsupported transport type: nope'
      );
    });

    it('logs portable sandbox hint and ignores logger.warn failures when policy enforcement is applied', async () => {
      const logger = makeLogger({
        warn: () => {
          throw new Error('logger is broken');
        }
      });

      const adapters = new ProtocolAdaptersImpl(logger);
      const adapter = await adapters.createAdapter(makeBaseConfig({
        transport: 'stdio',
        command: 'npm',
        args: ['exec', '@modelcontextprotocol/server-filesystem', '--version'],
        env: {}
      }));

      expect(adapter).toBeInstanceOf(StdioTransportAdapter);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[SANDBOX: portable]'));
    });

    it('throws when SANDBOX=container is set without a container image', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.createAdapter(makeBaseConfig({
        transport: 'stdio',
        container: undefined,
        env: { SANDBOX: 'container' } as any
      }))).rejects.toThrow(/Container image is required/i);
    });
  });

  describe('createXAdapter helpers', () => {
    it('createHttpAdapter throws if transport is not http', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.createHttpAdapter(makeBaseConfig({ transport: 'stdio' }))).rejects.toThrow(
        'createHttpAdapter expected transport=http, got stdio'
      );
    });

    it('createHttpAdapter returns an HttpTransportAdapter when transport=http', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter = await adapters.createHttpAdapter(makeBaseConfig({ transport: 'http', command: 'http://example.test' }));
      expect(adapter).toBeInstanceOf(HttpTransportAdapter);
    });

    it('createStreamableAdapter throws if transport is not streamable-http', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.createStreamableAdapter(makeBaseConfig({ transport: 'http' }))).rejects.toThrow(
        'createStreamableAdapter expected transport=streamable-http, got http'
      );
    });

    it('createStreamableAdapter returns a StreamableHttpAdapter when transport=streamable-http', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter = await adapters.createStreamableAdapter(makeBaseConfig({ transport: 'streamable-http', command: 'http://example.test' }));
      expect(adapter).toBeInstanceOf(StreamableHttpAdapter);
    });

    it('createStdioAdapter throws if transport is not stdio', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      await expect(adapters.createStdioAdapter(makeBaseConfig({ transport: 'http' }))).rejects.toThrow(
        'createStdioAdapter expected transport=stdio, got http'
      );
    });

    it('createStdioAdapter returns a StdioTransportAdapter when transport=stdio', async () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const adapter = await adapters.createStdioAdapter(makeBaseConfig({ transport: 'stdio' }));
      expect(adapter).toBeInstanceOf(StdioTransportAdapter);
    });
  });

  describe('isValidMcpResponse (private)', () => {
    it('treats only JSON-RPC 2.0 responses with result/error as valid', () => {
      const adapters = new ProtocolAdaptersImpl(makeLogger());
      const isValid = (adapters as any).isValidMcpResponse.bind(adapters) as (resp: unknown) => boolean;

      expect(isValid({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
      expect(isValid({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(true);

      // request-like / notification-like shapes should be rejected
      expect(isValid({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(false);
      expect(isValid({ jsonrpc: '2.0', method: 'notify' })).toBe(false);

      // invalid JSON / empty / wrong fields
      expect(isValid('not-json')).toBe(false);
      expect(isValid({})).toBe(false);
      expect(isValid({ jsonrpc: '1.0', result: {} })).toBe(false);
      expect(isValid({ jsonrpc: '2.0', id: 1 })).toBe(false);
    });
  });
});

