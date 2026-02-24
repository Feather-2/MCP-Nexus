import { AdapterRegistry } from '../../adapters/AdapterRegistry.js';
import type { Logger, McpServiceConfig, TransportAdapter } from '../../types/index.js';

function createLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createConfig(transport: McpServiceConfig['transport']): McpServiceConfig {
  return {
    name: 'registry-test',
    version: '2024-11-26',
    transport,
    command: 'node',
    args: [],
    timeout: 1000,
    retries: 0,
    env: {}
  };
}

function createAdapter(type: TransportAdapter['type']): TransportAdapter {
  return {
    type,
    version: '2024-11-26',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    receive: vi.fn(async () => ({ jsonrpc: '2.0' as const, id: 1, result: {} })),
    isConnected: vi.fn(() => true)
  };
}

describe('AdapterRegistry', () => {
  it('creates adapter through registered factory', async () => {
    const registry = new AdapterRegistry();
    const adapter = createAdapter('http');

    registry.register('http', () => adapter);

    await expect(
      registry.create('http', {
        config: createConfig('http'),
        logger: createLogger(),
        enforced: { applied: false, reasons: [], policy: { container: {} }, config: createConfig('http') } as any
      })
    ).resolves.toBe(adapter);
  });

  it('throws when registering same transport twice', () => {
    const registry = new AdapterRegistry();
    registry.register('stdio', () => createAdapter('stdio'));

    expect(() => registry.register('stdio', () => createAdapter('stdio'))).toThrow(
      'Adapter factory already registered for transport: stdio'
    );
  });

  it('throws for unregistered transport', async () => {
    const registry = new AdapterRegistry();
    await expect(
      registry.create('streamable-http', {
        config: createConfig('streamable-http'),
        logger: createLogger(),
        enforced: { applied: false, reasons: [], policy: { container: {} }, config: createConfig('streamable-http') } as any
      })
    ).rejects.toThrow('Unsupported transport type: streamable-http');
  });
});

