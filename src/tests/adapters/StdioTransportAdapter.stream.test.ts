import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'node:stream';
import { StdioTransportAdapter } from '../../adapters/StdioTransportAdapter.js';
import { McpServiceConfig, Logger, McpMessage } from '../../types/index.js';

vi.mock('child_process');

class MockChildProcess extends EventEmitter {
  pid = 12345;
  stdin = { write: vi.fn() };
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn().mockImplementation(() => {
    this.killed = true;
    return true;
  });
}

function writeInChunks(stream: PassThrough, text: string, chunkSize: number): void {
  for (let i = 0; i < text.length; i += chunkSize) {
    stream.write(text.slice(i, i + chunkSize));
  }
}

describe('StdioTransportAdapter stream parsing', () => {
  let adapter: StdioTransportAdapter;
  let mockLogger: Logger;
  let mockConfig: McpServiceConfig;
  let mockProcess: MockChildProcess;
  let received: McpMessage[];

  beforeEach(async () => {
    mockLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    mockConfig = {
      name: 'test-stdio-service',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'node',
      args: ['fake.js'],
      timeout: 5000,
      retries: 1,
      env: {}
    };

    mockProcess = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as any);

    adapter = new StdioTransportAdapter(mockConfig, mockLogger);
    received = [];
    adapter.on('message', (m) => received.push(m));

    await adapter.connect();
  });

  afterEach(() => {
    mockProcess.stdout.destroy();
    mockProcess.stderr.destroy();
    vi.clearAllMocks();
  });

  it('parses chunk-split and glued messages (including `}{` inside strings)', async () => {
    const msg1: McpMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { text: 'hello}{world' }
    };
    const msg2: McpMessage = {
      jsonrpc: '2.0',
      id: 2,
      method: 'notifications/test',
      params: { ok: true }
    };

    const glued = JSON.stringify(msg1) + JSON.stringify(msg2);

    mockProcess.stdout.write(glued.slice(0, 7));
    expect(received).toHaveLength(0);

    mockProcess.stdout.write(glued.slice(7, 23));
    expect(received).toHaveLength(0);

    mockProcess.stdout.write(glued.slice(23));

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject(msg1);
    expect(received[1]).toMatchObject(msg2);

    // Verify the adapter queue is populated via the same path.
    expect(await adapter.receive()).toMatchObject(msg1);
    expect(await adapter.receive()).toMatchObject(msg2);
  });

  it('parses large payloads (>64KB) from stdout without relying on newlines', () => {
    const big = 'y'.repeat(70 * 1024);
    const msg1: McpMessage = { jsonrpc: '2.0', id: 1, result: { big } };
    const msg2: McpMessage = { jsonrpc: '2.0', id: 2, result: { ok: true } };

    const glued = JSON.stringify(msg1) + JSON.stringify(msg2);
    writeInChunks(mockProcess.stdout, glued, 1024);

    expect(received).toHaveLength(2);
    expect((received[0].result as any).big).toHaveLength(big.length);
    expect(received[1]).toMatchObject({ id: 2, result: { ok: true } });
  });
});

