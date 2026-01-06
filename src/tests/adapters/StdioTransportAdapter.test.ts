import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { PassThrough } from 'node:stream';
import { StdioTransportAdapter } from '../../adapters/StdioTransportAdapter.js';
import { Logger, McpMessage, McpServiceConfig } from '../../types/index.js';

vi.mock('child_process');
vi.mock('fs/promises');

type KillBehavior = {
  sigtermSetsKilled?: boolean;
  sigtermReturn?: boolean;
  exitOnSigterm?: boolean;
  exitOnSigkill?: boolean;
};

class MockChildProcess extends EventEmitter {
  pid: number | undefined;
  stdin: { write: ReturnType<typeof vi.fn> };
  stdout: PassThrough | null;
  stderr: PassThrough | null;
  killed = false;
  kill: ReturnType<typeof vi.fn>;

  constructor(options: {
    pid?: number;
    stdinWriteImpl?: (data: string) => unknown;
    stdout?: PassThrough | null;
    stderr?: PassThrough | null;
    killBehavior?: KillBehavior;
  } = {}) {
    super();
    this.pid = Object.prototype.hasOwnProperty.call(options, 'pid') ? options.pid : 12345;
    this.stdout = options.stdout ?? new PassThrough();
    this.stderr = options.stderr ?? new PassThrough();
    this.stdin = { write: vi.fn(options.stdinWriteImpl ?? (() => true)) };

    const behavior: Required<KillBehavior> = {
      sigtermSetsKilled: options.killBehavior?.sigtermSetsKilled ?? true,
      sigtermReturn: options.killBehavior?.sigtermReturn ?? true,
      exitOnSigterm: options.killBehavior?.exitOnSigterm ?? true,
      exitOnSigkill: options.killBehavior?.exitOnSigkill ?? true
    };

    this.kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        if (behavior.sigtermSetsKilled) this.killed = true;
        if (behavior.exitOnSigterm) {
          queueMicrotask(() => this.emit('exit', 0, signal));
        }
        return behavior.sigtermReturn;
      }

      if (signal === 'SIGKILL') {
        this.killed = true;
        if (behavior.exitOnSigkill) {
          queueMicrotask(() => this.emit('exit', 0, signal));
        }
        return true;
      }

      this.killed = true;
      queueMicrotask(() => this.emit('exit', 0, signal));
      return true;
    });
  }
}

function createLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createConfig(overrides: Partial<McpServiceConfig> = {}): McpServiceConfig {
  return {
    name: 'test-stdio-service',
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['fake.js'],
    timeout: 250,
    retries: 1,
    env: {},
    ...overrides
  };
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...(platformDescriptor ?? { configurable: true, enumerable: true, writable: false }),
    value
  });
}

describe('StdioTransportAdapter', () => {
  let mockLogger: Logger;
  let mockConfig: McpServiceConfig;
  let adapter: StdioTransportAdapter;
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    mockLogger = createLogger();
    mockConfig = createConfig();
    mockProcess = new MockChildProcess();

    vi.mocked(spawn).mockReturnValue(mockProcess as any);
    vi.mocked(fs.access).mockResolvedValue(undefined as any);

    adapter = new StdioTransportAdapter(mockConfig, mockLogger);
  });

  afterEach(async () => {
    setPlatform((platformDescriptor?.value as NodeJS.Platform) ?? process.platform);

    try {
      if (adapter.isConnected()) {
        const disconnectPromise = adapter.disconnect();
        queueMicrotask(() => mockProcess.emit('exit', 0, 'SIGTERM'));
        await disconnectPromise;
      }
    } catch {
      // Ignore cleanup errors from intentionally-broken mocks.
    }

    mockProcess.stdout?.destroy();
    mockProcess.stderr?.destroy();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('connection lifecycle', () => {
    it('connect() starts a child process successfully', async () => {
      await adapter.connect();

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'node',
        ['fake.js'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          env: expect.any(Object)
        })
      );
      expect(adapter.isConnected()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('Stdio adapter connected for test-stdio-service');
    });

    it('connect() is idempotent when already connected', async () => {
      await adapter.connect();
      await adapter.connect();
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    });

    it('connect() throws when command is missing', async () => {
      adapter = new StdioTransportAdapter(createConfig({ command: undefined }), mockLogger);
      await expect(adapter.connect()).rejects.toThrow('Command is required for stdio transport');
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('connect() throws when process fails to start (missing pid)', async () => {
      const badProc = new MockChildProcess({ pid: undefined });
      vi.mocked(spawn).mockReturnValueOnce(badProc as any);

      await expect(adapter.connect()).rejects.toThrow('Failed to start process: node');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to connect stdio adapter:', expect.any(Error));
    });

    it('disconnect() gracefully kills the process (SIGTERM)', async () => {
      await adapter.connect();

      const disconnectPromise = adapter.disconnect();
      await vi.waitFor(() => expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM'));

      await disconnectPromise;
      expect(adapter.isConnected()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('Stdio adapter disconnected for test-stdio-service');
    });

    it('disconnect() force kills after timeout when SIGTERM does not terminate', async () => {
      vi.useFakeTimers();

      mockProcess = new MockChildProcess({
        killBehavior: {
          sigtermSetsKilled: false,
          sigtermReturn: false,
          exitOnSigterm: false,
          exitOnSigkill: true
        }
      });
      vi.mocked(spawn).mockReturnValueOnce(mockProcess as any);
      adapter = new StdioTransportAdapter(mockConfig, mockLogger);

      await adapter.connect();

      const disconnectPromise = adapter.disconnect();

      await vi.waitFor(() => expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM'));

      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL'));

      await disconnectPromise;
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('data flow', () => {
    beforeEach(async () => {
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('send() writes JSON to stdin and emits `sent`', async () => {
      const message: McpMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
        params: { ok: true }
      };

      const sent: McpMessage[] = [];
      adapter.on('sent', (m) => sent.push(m));

      await adapter.send(message);

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(JSON.stringify(message) + '\n');
      expect(sent).toEqual([message]);
    });

    it('receive() resolves when a new message arrives on stdout', async () => {
      const msg: McpMessage = { jsonrpc: '2.0', method: 'notifications/test', params: { ok: true } };

      const receivePromise = adapter.receive();
      mockProcess.stdout!.write(JSON.stringify(msg));

      await expect(receivePromise).resolves.toEqual(msg);
    });

    it('receive() times out when no message arrives', async () => {
      vi.useFakeTimers();

      const shortTimeoutAdapter = new StdioTransportAdapter(createConfig({ timeout: 50 }), mockLogger);
      vi.mocked(spawn).mockReturnValueOnce(new MockChildProcess() as any);
      await shortTimeoutAdapter.connect();

      const promise = shortTimeoutAdapter.receive();
      const assertion = expect(promise).rejects.toThrow('Receive timeout');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    });

    it('send() throws when pipe is broken (stdin.write throws)', async () => {
      const broken = new MockChildProcess({
        stdinWriteImpl: () => {
          throw new Error('EPIPE');
        }
      });
      vi.mocked(spawn).mockReturnValueOnce(broken as any);

      const brokenAdapter = new StdioTransportAdapter(mockConfig, mockLogger);
      await brokenAdapter.connect();

      await expect(brokenAdapter.send({ jsonrpc: '2.0', id: 1, method: 'x' })).rejects.toThrow('EPIPE');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to send message via stdio:', expect.any(Error));
    });
  });

  describe('not connected guards', () => {
    it('send() rejects when not connected', async () => {
      await expect(adapter.send({ jsonrpc: '2.0', id: 1, method: 'x' })).rejects.toThrow('Adapter not connected');
    });

    it('receive() rejects when not connected', async () => {
      await expect(adapter.receive()).rejects.toThrow('Adapter not connected');
    });

    it('disconnect() is a no-op when not connected', async () => {
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('request-response', () => {
    beforeEach(async () => {
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('sendAndReceive() resolves when a response with matching ID arrives', async () => {
      const request: McpMessage = { jsonrpc: '2.0', id: 'req-1', method: 'tools/list' };
      const response: McpMessage = { jsonrpc: '2.0', id: 'req-1', result: { tools: [] } };

      const responsePromise = adapter.sendAndReceive(request);
      mockProcess.stdout!.write(JSON.stringify(response));

      await expect(responsePromise).resolves.toEqual(response);
      expect((adapter as any).responseCallbacks.size).toBe(0);
    });

    it('sendAndReceive() generates an ID when missing', async () => {
      const request: any = { jsonrpc: '2.0', method: 'tools/list' };
      const promise = adapter.sendAndReceive(request);

      expect(request.id).toMatch(/^req-\d+-[a-z0-9]+$/);

      mockProcess.stdout!.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }));
      await promise;
    });

    it('sendAndReceive() rejects on request timeout and clears callback', async () => {
      vi.useFakeTimers();

      const shortTimeoutAdapter = new StdioTransportAdapter(createConfig({ timeout: 25 }), mockLogger);
      vi.mocked(spawn).mockReturnValueOnce(new MockChildProcess() as any);
      await shortTimeoutAdapter.connect();

      const msg: McpMessage = { jsonrpc: '2.0', id: 'timeout-test', method: 'x' };
      const promise = shortTimeoutAdapter.sendAndReceive(msg);

      const assertion = expect(promise).rejects.toThrow('Request timeout for message timeout-test');
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
      expect((shortTimeoutAdapter as any).responseCallbacks.size).toBe(0);
    });

    it('disconnect() rejects pending sendAndReceive() promises with Connection closed', async () => {
      const pending = adapter.sendAndReceive({ jsonrpc: '2.0', id: 'pending-1', method: 'x' });

      const disconnectPromise = adapter.disconnect();
      await expect(pending).rejects.toThrow('Connection closed');

      await disconnectPromise;
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('emits disconnect when child process exits (crash)', async () => {
      const events: any[] = [];
      adapter.on('disconnect', (e) => events.push(e));

      mockProcess.emit('exit', 1, 'SIGTERM');

      await vi.waitFor(() => expect(events).toEqual([{ code: 1, signal: 'SIGTERM' }]));
      expect(adapter.isConnected()).toBe(false);
    });

    it('captures stderr line-by-line and emits env-hint when it looks like a missing secret', async () => {
      const stderrEvents: string[] = [];
      adapter.on('stderr', (line) => stderrEvents.push(line));

      mockProcess.stderr!.write('BRAVE_API_KEY environment variable is required\n');
      mockProcess.stderr!.write('second line\n');

      await vi.waitFor(() => {
        expect(stderrEvents).toContain('env-hint: BRAVE_API_KEY environment variable is required');
        expect(stderrEvents).toContain('BRAVE_API_KEY environment variable is required');
        expect(stderrEvents).toContain('second line');
      });
      expect(mockLogger.warn).toHaveBeenCalledWith('Stdio stderr:', 'BRAVE_API_KEY environment variable is required');
    });

    it('emits env-error hint on process error events for missing env patterns', async () => {
      const stderrEvents: string[] = [];
      const errorEvents: any[] = [];
      adapter.on('stderr', (line) => stderrEvents.push(line));
      adapter.on('error', (err) => errorEvents.push(err));

      const err = new Error('BRAVE_API_KEY environment variable is required');
      mockProcess.emit('error', err);

      await vi.waitFor(() => {
        expect(stderrEvents).toContain('env-error: BRAVE_API_KEY environment variable is required');
        expect(errorEvents).toEqual([err]);
      });
      expect(mockLogger.error).toHaveBeenCalledWith('Stdio process error:', err);
    });

    it('logs a warning when stdout contains an invalid JSON-RPC frame', () => {
      // Completes a frame but is not valid JSON (trailing comma).
      mockProcess.stdout!.write('{"jsonrpc":"2.0",}');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to parse stdio JSON-RPC frame',
        expect.objectContaining({
          error: expect.any(String),
          rawLength: expect.any(Number)
        })
      );
    });
  });

  describe('sandbox isolation', () => {
    it('buildIsolatedEnv() filters environment in portable sandbox mode', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/bin',
        HTTP_PROXY: 'http://proxy.example',
        SYSTEMROOT: 'C:\\\\Windows'
      };

      const config = createConfig({
        env: {
          SANDBOX: 'portable',
          SANDBOX_NODE_DIR: '/sandbox/node',
          SANDBOX_PYTHON_DIR: '/sandbox/python',
          SANDBOX_GO_DIR: '/sandbox/go',
          CUSTOM: 123 as any
        }
      });
      const portableAdapter = new StdioTransportAdapter(config, mockLogger);

      const env = (portableAdapter as any).buildIsolatedEnv(baseEnv, config.env);

      expect(env.HTTP_PROXY).toBe('');
      expect(env.npm_config_prefer_offline).toBe('true');
      expect(env.CUSTOM).toBe('123');
      expect(env.PATH).toContain('/sandbox/node');
      expect(env.PATH).toContain('/sandbox/python');
      expect(env.PATH).toContain('/sandbox/go');
      expect(env.PATH).toContain('/usr/bin');
    });

    it('buildIsolatedEnv() uses platform-specific runtime paths (win32 vs linux)', () => {
      const baseEnv: NodeJS.ProcessEnv = { PATH: '/base' };
      const overrideEnv = {
        SANDBOX: 'portable',
        SANDBOX_NODE_DIR: '/sandbox/node',
        SANDBOX_PYTHON_DIR: '/sandbox/python',
        SANDBOX_GO_DIR: '/sandbox/go'
      };

      const adapterAny = new StdioTransportAdapter(createConfig({ env: overrideEnv }), mockLogger) as any;

      setPlatform('win32');
      const winEnv = adapterAny.buildIsolatedEnv(baseEnv, overrideEnv);
      expect(winEnv.PATH).toContain('/sandbox/python/Scripts');
      expect(winEnv.PATH?.startsWith('/sandbox/node')).toBe(true);

      setPlatform('linux');
      const linuxEnv = adapterAny.buildIsolatedEnv(baseEnv, overrideEnv);
      expect(linuxEnv.PATH).toContain('/sandbox/python/bin');
      expect(linuxEnv.PATH).toContain('/sandbox/node/bin');
    });

    it('connect() infers portable cwd for scoped npx packages and enforces offline deps', async () => {
      const inferredConfig = createConfig({
        command: 'npx',
        args: ['--package', '@scope/pkg@1.2.3', '--no-install'],
        env: { SANDBOX: 'portable' } as any
      });
      const inferredAdapter = new StdioTransportAdapter(inferredConfig, mockLogger);

      const expectedCwd = path.resolve(process.cwd(), '../mcp-sandbox/packages/@scope');
      const expectedPkgDir = path.join(expectedCwd, 'node_modules', '@scope', 'pkg');

      await inferredAdapter.connect();

      expect(vi.mocked(fs.access)).toHaveBeenCalledWith(expectedPkgDir);
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'npx',
        inferredConfig.args!,
        expect.objectContaining({ cwd: expectedCwd })
      );
    });

    it('connect() passes cwd when USE_CWD=1 for non-portable services', async () => {
      const cfg = createConfig({
        workingDirectory: process.cwd(),
        env: { USE_CWD: '1' } as any
      });
      const a = new StdioTransportAdapter(cfg, mockLogger);

      await a.connect();

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'node',
        cfg.args!,
        expect.objectContaining({ cwd: process.cwd() })
      );
    });

    it('connect() infers portable cwd for npm exec packages', async () => {
      const cfg = createConfig({
        command: 'npm',
        args: ['exec', '--package', '@scope/pkg@2.0.0', '--no-install'],
        env: { SANDBOX: 'portable' } as any
      });
      const a = new StdioTransportAdapter(cfg, mockLogger);

      const expectedCwd = path.resolve(process.cwd(), '../mcp-sandbox/packages/@scope');
      await a.connect();

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'npm',
        cfg.args!,
        expect.objectContaining({ cwd: expectedCwd })
      );
    });

    it('connect() rejects portable offline execution when lockfile is missing', async () => {
      vi.mocked(fs.access).mockImplementation(async (p: any) => {
        const target = String(p);
        if (target.endsWith('package-lock.json') || target.endsWith('npm-shrinkwrap.json')) {
          throw new Error('ENOENT');
        }
        return undefined as any;
      });

      const cfg = createConfig({
        command: 'npx',
        args: ['--package', 'leftpad@1.0.0', '--no-install'],
        env: { SANDBOX: 'portable' } as any
      });
      const a = new StdioTransportAdapter(cfg, mockLogger);

      await expect(a.connect()).rejects.toThrow('Portable sandbox requires locked, preinstalled npm deps.');
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('connect() rejects workingDirectory outside allowed path', async () => {
      const cfg = createConfig({ workingDirectory: '/tmp', env: {} as any });
      const a = new StdioTransportAdapter(cfg, mockLogger);

      await expect(a.connect()).rejects.toThrow('Working directory outside allowed path');
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });
  });

  describe('windows-specific behavior', () => {
    it('normalizes node/npm/npx commands and enforces allowlist on win32', async () => {
      setPlatform('win32');

      const winConfig = createConfig({ command: 'node' });
      const winAdapter = new StdioTransportAdapter(winConfig, mockLogger);
      await winAdapter.connect();

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'node.exe',
        winConfig.args!,
        expect.any(Object)
      );

      const blockedConfig = createConfig({ command: 'evil' });
      const blockedAdapter = new StdioTransportAdapter(blockedConfig, mockLogger);
      await expect(blockedAdapter.connect()).rejects.toThrow('Command not allowed: evil');
    });

    it('passes shell=true only when USE_SHELL=1 on win32', async () => {
      setPlatform('win32');

      const cfg = createConfig({ command: 'npm', env: { USE_SHELL: '1' } as any });
      const a = new StdioTransportAdapter(cfg, mockLogger);
      await a.connect();

      const spawnArgs = vi.mocked(spawn).mock.calls[0]!;
      expect(spawnArgs[2]).toEqual(expect.objectContaining({ shell: true }));
    });
  });

  describe('manual reconnect', () => {
    it('can connect again after process exit', async () => {
      await adapter.connect();
      mockProcess.emit('exit', 0, 'SIGTERM');
      expect(adapter.isConnected()).toBe(false);

      const secondProcess = new MockChildProcess();
      vi.mocked(spawn).mockReturnValueOnce(secondProcess as any);

      await adapter.connect();
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
      expect(adapter.isConnected()).toBe(true);
    });
  });
});
