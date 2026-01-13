import Fastify from 'fastify';
import { EventEmitter } from 'events';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../types/index.js';
import { SandboxRoutes } from '../../../server/routes/SandboxRoutes.js';
import * as fs from 'fs/promises';
import * as https from 'https';
import { createHash } from 'crypto';

const {
  fsAccess,
  fsMkdir,
  fsReaddir,
  fsCopyFile,
  fsRm,
  fsRename,
  fsStat,
  fsUnlink,
  fsRmdir,
  fsWriteFile,
  fsReadFile,
  createWriteStreamMock,
  spawnMock,
  httpsGetMock,
  httpGetMock,
  pipelineMock,
  promisifyMock
} = vi.hoisted(() => ({
  fsAccess: vi.fn(),
  fsMkdir: vi.fn(),
  fsReaddir: vi.fn(),
  fsCopyFile: vi.fn(),
  fsRm: vi.fn(),
  fsRename: vi.fn(),
  fsStat: vi.fn(),
  fsUnlink: vi.fn(),
  fsRmdir: vi.fn(),
  fsWriteFile: vi.fn(),
  fsReadFile: vi.fn(),
  createWriteStreamMock: vi.fn(),
  spawnMock: vi.fn(),
  httpsGetMock: vi.fn(),
  httpGetMock: vi.fn(),
  pipelineMock: vi.fn(),
  promisifyMock: vi.fn()
}));

vi.mock('fs/promises', () => ({
  access: fsAccess,
  mkdir: fsMkdir,
  readdir: fsReaddir,
  copyFile: fsCopyFile,
  rm: fsRm,
  rename: fsRename,
  stat: fsStat,
  unlink: fsUnlink,
  rmdir: fsRmdir,
  writeFile: fsWriteFile,
  readFile: fsReadFile
}));

vi.mock('fs', () => ({ createWriteStream: createWriteStreamMock }));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('https', () => ({ get: httpsGetMock }));
vi.mock('http', () => ({ get: httpGetMock }));
vi.mock('stream', () => ({ pipeline: pipelineMock }));
vi.mock('util', () => ({ promisify: promisifyMock }));

type MockFsState = {
  existing: Set<string>;
  files: Map<string, Buffer>;
  readdir: Map<string, Array<string>>;
  dirents: Map<string, Array<{ name: string; isDirectory: () => boolean }>>;
  stats: Map<string, { size: number; isDirectory: () => boolean }>;
};

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRouteContext(server: FastifyInstance, logger: Logger, corsOrigins: string[] = ['http://allowed.test']) {
  return {
    server,
    logger,
    configManager: { config: { corsOrigins } },
    sandboxStreamClients: new Set(),
    sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
    sandboxInstalling: false,
    respondError: (reply: any, status: number, message: string, opts?: any) => {
      const payload = {
        success: false,
        error: {
          message,
          code: opts?.code || 'INTERNAL_ERROR',
          recoverable: opts?.recoverable ?? false,
          meta: opts?.meta
        }
      };
      return reply.code(status).send(payload);
    }
  } as any;
}

function setProcessPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setProcessArch(value: string) {
  Object.defineProperty(process, 'arch', { value, configurable: true });
}

function makeChildProcess(opts: { stdoutText?: string; stderrText?: string; closeCode?: number; emitError?: boolean } = {}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (opts.emitError) {
      child.emit('error', new Error('spawn error'));
      return;
    }
    if (opts.stdoutText) child.stdout.emit('data', Buffer.from(opts.stdoutText));
    if (opts.stderrText) child.stderr.emit('data', Buffer.from(opts.stderrText));
    child.emit('close', opts.closeCode ?? 0);
  });

  return child;
}

function makeFsState(): MockFsState {
  return {
    existing: new Set(),
    files: new Map(),
    readdir: new Map(),
    dirents: new Map(),
    stats: new Map()
  };
}

function installFsMocks(state: MockFsState) {
  fsAccess.mockImplementation(async (p: string) => {
    if (!state.existing.has(p)) {
      const err: any = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }
  });

  fsMkdir.mockImplementation(async (p: string) => {
    state.existing.add(p);
  });

  fsReaddir.mockImplementation(async (p: string, options?: any) => {
    if (options?.withFileTypes) {
      return state.dirents.get(p) || [];
    }
    return state.readdir.get(p) || [];
  });

  fsCopyFile.mockImplementation(async (_src: string, dest: string) => {
    state.existing.add(dest);
  });

  fsRm.mockImplementation(async (p: string) => {
    state.existing.delete(p);
  });

  fsRename.mockImplementation(async (from: string, to: string) => {
    if (!state.existing.has(from)) {
      const err: any = new Error(`ENOENT: ${from}`);
      err.code = 'ENOENT';
      throw err;
    }
    state.existing.delete(from);
    state.existing.add(to);
  });

  fsStat.mockImplementation(async (p: string) => {
    return (
      state.stats.get(p) || {
        size: 2048,
        isDirectory: () => false
      }
    );
  });

  fsUnlink.mockImplementation(async (p: string) => {
    state.existing.delete(p);
    state.files.delete(p);
  });

  fsRmdir.mockImplementation(async (p: string) => {
    state.existing.delete(p);
  });

  fsWriteFile.mockImplementation(async (p: string, contents: any) => {
    state.existing.add(p);
    state.files.set(p, Buffer.from(String(contents)));
  });

  fsReadFile.mockImplementation(async (p: string) => {
    return state.files.get(p) ?? Buffer.from('archive-bytes');
  });

  createWriteStreamMock.mockImplementation((p: string) => {
    state.existing.add(p);
    return { path: p } as any;
  });
}

function installNetworkMocks(state: { redirects?: boolean; statusCode?: number }) {
  const makeResponse = (url: string) => {
    const statusCode = state.statusCode ?? 200;
    if (state.redirects) {
      return { statusCode: 302, headers: { location: url.replace('https://', 'http://') } } as any;
    }
    return { statusCode, headers: {} } as any;
  };

  const getImpl = (url: string, cb: (res: any) => void) => {
    const res = makeResponse(url);
    cb(res);
    return { on: vi.fn() } as any;
  };
  httpsGetMock.mockImplementation(getImpl);
  httpGetMock.mockImplementation(getImpl);

  promisifyMock.mockImplementation((_fn: any) => {
    return async (_src: any, _dest: any) => undefined;
  });
}

describe('SandboxRoutes', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    vi.clearAllMocks();
    setProcessPlatform(originalPlatform);
    setProcessArch(originalArch);
  });

  afterAll(() => {
    setProcessPlatform(originalPlatform);
    setProcessArch(originalArch);
  });

  it('writeSseHeaders reflects allowed Origin', () => {
    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger(), ['http://allowed.test']));
    const captured: any = {};
    const fakeReply: any = { raw: { writeHead: (_code: number, headers: any) => Object.assign(captured, headers) } };
    const fakeReq: any = { headers: { origin: 'http://allowed.test' } };

    (routes as any).writeSseHeaders(fakeReply, fakeReq);
    expect(captured['Content-Type']).toContain('text/event-stream');
    expect(captured['Access-Control-Allow-Origin']).toBe('http://allowed.test');
    expect(captured['Vary']).toBe('Origin');
  });

  it('GET /api/sandbox/status returns status (uninitialized paths)', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    spawnMock.mockImplementation(() => makeChildProcess({ stdoutText: 'v0.0.0' }));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    routes.setupRoutes();

    const res = await server.inject({ method: 'GET', url: '/api/sandbox/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        nodeReady: false,
        pythonReady: false,
        goReady: false,
        packagesReady: false,
        details: expect.any(Object)
      })
    );
  });

  it('POST /api/sandbox/install rejects when installer busy and resets flag after error', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    const server = Fastify({ logger: false });
    const ctx = makeRouteContext(server, makeLogger());
    ctx.sandboxInstalling = true;
    const routes = new SandboxRoutes(ctx);
    routes.setupRoutes();

    const busy = await server.inject({ method: 'POST', url: '/api/sandbox/install', payload: { components: ['node'] } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('BUSY');

    // Force internal error by making spawn emit error during version probe
    ctx.sandboxInstalling = false;
    spawnMock.mockImplementation(() => makeChildProcess({ emitError: true }));
    const err = await server.inject({ method: 'POST', url: '/api/sandbox/install', payload: { components: ['node'] } });
    expect(err.statusCode).toBe(500);
    expect(ctx.sandboxInstalling).toBe(false);
  });

  it('POST /api/sandbox/repair returns "No missing components" when already ready', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    // Pretend all expected paths exist so inspectSandbox reports ready.
    const root = process.cwd();
    const runtimesDir = (await import('path')).resolve(root, '../mcp-sandbox/runtimes');
    const pkgsDir = (await import('path')).resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');
    state.existing.add((await import('path')).join(runtimesDir, 'nodejs', 'bin', 'node'));
    state.existing.add((await import('path')).join(runtimesDir, 'nodejs', 'bin', 'npm'));
    state.existing.add((await import('path')).join(runtimesDir, 'python', 'bin'));
    state.existing.add((await import('path')).join(runtimesDir, 'go', 'bin'));
    state.existing.add((await import('path')).join(pkgsDir, 'server-filesystem'));
    state.existing.add((await import('path')).join(pkgsDir, 'server-memory'));

    spawnMock.mockImplementation(() => makeChildProcess({ stdoutText: 'v1.0.0' }));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    routes.setupRoutes();

    const res = await server.inject({ method: 'POST', url: '/api/sandbox/repair', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('No missing components');
  });

  it('POST /api/sandbox/cleanup deletes leftover archives and returns status', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    const path = await import('path');
    const root = process.cwd();
    const runtimesDir = path.resolve(root, '../mcp-sandbox/runtimes');
    const nodejsDir = path.join(runtimesDir, 'nodejs');
    const pyDir = path.join(runtimesDir, 'python');
    const goDir = path.join(runtimesDir, 'go');

    state.readdir.set(nodejsDir, ['a.zip', 'keep.txt', 'b.tar.gz']);
    state.readdir.set(pyDir, ['c.tgz']);
    state.readdir.set(goDir, []);
    state.existing.add(path.join(nodejsDir, 'a.zip'));
    state.existing.add(path.join(nodejsDir, 'b.tar.gz'));
    state.existing.add(path.join(pyDir, 'c.tgz'));

    spawnMock.mockImplementation(() => makeChildProcess({ stdoutText: 'v1.0.0' }));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    routes.setupRoutes();

    const res = await server.inject({ method: 'POST', url: '/api/sandbox/cleanup' });
    expect(res.statusCode).toBe(200);
    expect(fs.unlink).toHaveBeenCalledTimes(3);
    expect(res.json().success).toBe(true);
  });

  it('GET /api/sandbox/install/stream streams progress and completes', async () => {
    const state = makeFsState();
    installFsMocks(state);

    // Cover redirect branch once, then success.
    let call = 0;
    httpsGetMock.mockImplementation((url: string, cb: (r: any) => void) => {
      call += 1;
      if (call === 1) cb({ statusCode: 302, headers: { location: url.replace('https://', 'http://') } });
      else cb({ statusCode: 200, headers: {} });
      return { on: vi.fn() } as any;
    });
    httpGetMock.mockImplementation((_url: string, cb: (r: any) => void) => {
      cb({ statusCode: 200, headers: {} });
      return { on: vi.fn() } as any;
    });
    promisifyMock.mockImplementation((_fn: any) => {
      return async (_src: any, _dest: any) => undefined;
    });

    // Make extraction "install" expected binaries so inspectSandbox can probe versions.
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (String(args?.[0] ?? '').includes('-v')) return makeChildProcess({ stdoutText: 'v20.15.0' });
      if (String(args?.[0] ?? '').includes('--version')) return makeChildProcess({ stdoutText: 'Python 3.11.9' });
      if (String(args?.[0] ?? '') === 'version') return makeChildProcess({ stdoutText: 'go version go1.22.5' });
      return makeChildProcess({});
    });

    // SHA checks (exercise code paths)
    const buf = Buffer.from('archive-bytes');
    const sha = createHash('sha256').update(buf).digest('hex');
    state.files.set('/any', buf);
    fsReadFile.mockResolvedValue(buf);
    process.env.PB_RUNTIME_SHA256_NODE = sha;
    process.env.PB_RUNTIME_SHA256_PYTHON = sha;
    process.env.PB_RUNTIME_SHA256_GO = sha;

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    routes.setupRoutes();

    const res = await server.inject({ method: 'GET', url: '/api/sandbox/install/stream' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('"event":"start"');
    expect(res.payload).toContain('"event":"complete"');
    expect(res.payload).toContain('"event":"component_start"');

    delete process.env.PB_RUNTIME_SHA256_NODE;
    delete process.env.PB_RUNTIME_SHA256_PYTHON;
    delete process.env.PB_RUNTIME_SHA256_GO;
  });

  it('installSandboxComponents handles Go extracted dir restructure (directory + file fallbacks)', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => makeChildProcess({}));

    const path = await import('path');
    const root = process.cwd();
    const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/go');
    const extractedGoDir = path.join(runtimeDir, 'go');
    const fromBin = path.join(extractedGoDir, 'bin');
    const fromReadme = path.join(extractedGoDir, 'README.md');

    state.existing.add(extractedGoDir);
    state.existing.add(fromBin);
    state.existing.add(fromReadme);
    state.readdir.set(extractedGoDir, ['bin', 'README.md']);
    state.stats.set(fromBin, { size: 0, isDirectory: () => true });
    state.stats.set(fromReadme, { size: 10, isDirectory: () => false });

    // copyDir reads withFileTypes from the directory source
    state.dirents.set(fromBin, [{ name: 'go', isDirectory: () => false }]);
    state.existing.add(path.join(fromBin, 'go'));

    fsRename.mockImplementation(async (from: string, to: string) => {
      if (from === fromBin) {
        const err: any = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      if (from === fromReadme) {
        const err: any = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }
      state.existing.delete(from);
      state.existing.add(to);
    });

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));

    const result = await (routes as any).installSandboxComponents(['go']);
    expect(result).toEqual(expect.any(Object));
    expect(fs.copyFile).toHaveBeenCalled();
    expect(fs.rmdir).toHaveBeenCalled();
  });

  it('installSandboxComponents throws if Go extracted dir move fails with unexpected error', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => makeChildProcess({}));

    const path = await import('path');
    const root = process.cwd();
    const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/go');
    const extractedGoDir = path.join(runtimeDir, 'go');
    const from = path.join(extractedGoDir, 'bin');

    state.existing.add(extractedGoDir);
    state.existing.add(from);
    state.readdir.set(extractedGoDir, ['bin']);
    state.stats.set(from, { size: 0, isDirectory: () => true });

    fsRename.mockImplementation(async () => {
      const err: any = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    });

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    await expect((routes as any).installSandboxComponents(['go'])).rejects.toThrow('EINVAL');
  });

  it('installSandboxComponents short-circuits Go when already installed', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    const path = await import('path');
    const root = process.cwd();
    const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/go');
    const goBin = path.join(runtimeDir, 'bin', 'go');
    state.existing.add(goBin);

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => makeChildProcess({ stdoutText: 'go version go1.22.5' }));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    const res = await (routes as any).installSandboxComponents(['go']);

    expect(res).toEqual(expect.any(Object));
    expect(https.get).not.toHaveBeenCalled();
  });

  it('installSandboxComponents installs packages via npm when available', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    const path = await import('path');
    const root = process.cwd();
    const nodeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
    const orgDir = path.resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');
    const nodeBin = path.join(nodeDir, 'bin', 'node');
    const npmBin = path.join(nodeDir, 'bin', 'npm');

    state.existing.add(nodeBin);
    state.existing.add(npmBin);

    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: any) => makeChildProcess({}));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    await (routes as any).installSandboxComponents(['packages']);

    const calls = spawnMock.mock.calls;
    expect(
      calls.some(([cmd, args, opts]: any[]) => cmd === npmBin && Array.isArray(args) && args[0] === 'install' && opts?.cwd === orgDir)
    ).toBe(true);
  });

  it('installSandboxComponents falls back to node + npm-cli.js when npm is missing', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    const path = await import('path');
    const root = process.cwd();
    const nodeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
    const orgDir = path.resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');
    const nodeBin = path.join(nodeDir, 'bin', 'node');

    state.existing.add(nodeBin);

    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: any) => makeChildProcess({}));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    await (routes as any).installSandboxComponents(['packages']);

    const calls = spawnMock.mock.calls;
    expect(
      calls.some(([cmd, args, opts]: any[]) => cmd === nodeBin && Array.isArray(args) && String(args[0]).includes('npm-cli.js') && opts?.cwd === orgDir)
    ).toBe(true);
  });

  it('installSandboxComponents throws when packages requested without Node runtime', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => makeChildProcess({}));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    await expect((routes as any).installSandboxComponents(['packages'])).rejects.toThrow('请先安装 Node.js 运行时');
  });

  it('installSandboxComponents supports Windows python embed flow (pip wrapper)', async () => {
    setProcessPlatform('win32');
    setProcessArch('x64');

    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => makeChildProcess({}));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));

    await (routes as any).installSandboxComponents(['python']);

    const path = await import('path');
    const root = process.cwd();
    const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/python');
    const pipPath = path.join(runtimeDir, 'Scripts', 'pip.exe');
    expect(fs.writeFile).toHaveBeenCalledWith(pipPath, expect.stringContaining('-m pip'));
  });

  it('installSandboxComponents supports Windows zip flow and EPERM rename fallback', async () => {
    setProcessPlatform('win32');
    setProcessArch('x64');

    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    // Set up extracted node dir contents so windows reorganize branch runs.
    const path = await import('path');
    const root = process.cwd();
    const nodeRuntimeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
    const extractedDir = path.join(nodeRuntimeDir, 'node-v20.15.0-win-x64');
    state.existing.add(extractedDir);
    state.readdir.set(extractedDir, ['bin', 'node.exe']);
    state.stats.set(path.join(extractedDir, 'bin'), { size: 0, isDirectory: () => true });
    state.stats.set(path.join(extractedDir, 'node.exe'), { size: 4096, isDirectory: () => false });

    // Make rename fail for directory to exercise copyDir fallback.
    fsRename.mockImplementation(async (from: string, to: string) => {
      if (from.endsWith('bin')) {
        const err: any = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }
      state.existing.delete(from);
      state.existing.add(to);
    });

    // copyDir reads withFileTypes
    state.dirents.set(path.join(extractedDir, 'bin'), [{ name: 'npm.cmd', isDirectory: () => false }]);
    state.existing.add(path.join(extractedDir, 'bin', 'npm.cmd'));

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => makeChildProcess({}));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));

    const result = await (routes as any).installSandboxComponents(['node']);
    expect(result).toEqual(
      expect.objectContaining({
        nodeReady: expect.any(Boolean),
        details: expect.any(Object)
      })
    );
    expect(fs.copyFile).toHaveBeenCalled();
  });

  it('inspectSandbox version probes time out safely', async () => {
    vi.useFakeTimers();

    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});

    const path = await import('path');
    const root = process.cwd();
    const runtimesDir = path.resolve(root, '../mcp-sandbox/runtimes');
    const nodePath = path.join(runtimesDir, 'nodejs', 'bin', 'node');
    const npmPath = path.join(runtimesDir, 'nodejs', 'bin', 'npm');
    state.existing.add(nodePath);
    state.existing.add(npmPath);

    // Child never emits close/error -> triggers timeout branch in getVersion().
    spawnMock.mockImplementation(() => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      return child;
    });

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));

    const promise = (routes as any).inspectSandbox();
    await vi.advanceTimersByTimeAsync(1000);
    const status = await promise;

    expect(status).toEqual(expect.objectContaining({ nodeReady: true }));
    expect((spawnMock.mock.results[0] as any)?.value?.kill).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('handles invalid JSON body with 400', async () => {
    const state = makeFsState();
    installFsMocks(state);
    installNetworkMocks({});
    spawnMock.mockImplementation(() => makeChildProcess({}));

    const server = Fastify({ logger: false });
    const routes = new SandboxRoutes(makeRouteContext(server, makeLogger()));
    routes.setupRoutes();

    const res = await server.inject({
      method: 'POST',
      url: '/api/sandbox/install',
      payload: '{ bad json',
      headers: { 'content-type': 'application/json' }
    });
    expect(res.statusCode).toBe(400);
  });
});
