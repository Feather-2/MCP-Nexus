import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { join } from 'path';

/**
 * Sandbox runtime installation and management routes
 */
export class SandboxRoutes extends BaseRouteHandler {
  private sandboxProgress?: (evt: any) => void;

  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get sandbox status
    server.get('/api/sandbox/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      const status = await this.inspectSandbox();
      reply.send(status);
    });

    // Install components: { components?: string[] }
    server.post('/api/sandbox/install', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (this.ctx.sandboxInstalling) {
          return this.respondError(reply, 409, 'Sandbox installer busy', { code: 'BUSY', recoverable: true });
        }
        this.ctx.sandboxInstalling = true;
        const body = (request.body as any) || {};
        const components: string[] = Array.isArray(body.components) && body.components.length ? body.components : ['node', 'packages'];
        const result = await this.installSandboxComponents(components);
        reply.send({ success: true, result });
      } catch (error) {
        this.ctx.logger.error('Sandbox install failed:', error);
        return this.respondError(reply, 500, (error as Error).message || 'Sandbox install failed');
      } finally {
        this.ctx.sandboxInstalling = false;
      }
    });

    // Streaming install via SSE: GET /api/sandbox/install/stream?components=a,b,c
    server.get('/api/sandbox/install/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Prepare SSE response
        this.writeSseHeaders(reply, request);

        const sendTo = (r: FastifyReply, obj: any) => { try { r.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
        const broadcast = (obj: any) => {
          for (const r of Array.from(this.ctx.sandboxStreamClients)) {
            try { sendTo(r, obj); } catch { this.ctx.sandboxStreamClients.delete(r); }
          }
        };

        // Register this client
        this.ctx.sandboxStreamClients.add(reply);
        const onClose = () => { this.ctx.sandboxStreamClients.delete(reply); };
        request.socket.on('close', onClose);
        request.socket.on('end', onClose);
        request.socket.on('error', onClose);

        const q = (request.query as any) || {};
        const compsStr: string = (q.components as string) || '';
        const components: string[] = compsStr
          ? compsStr.split(',').map((s: string) => s.trim()).filter(Boolean)
          : ['node', 'python', 'go', 'packages'];

        sendTo(reply, { event: 'start', components });

        // If an installation is already in progress, attach and do not start a new one
        if (this.ctx.sandboxInstalling) {
          sendTo(reply, { event: 'attach' });
          return; // keep connection open to receive broadcasts
        }

        // Mark installing and set broadcaster
        this.ctx.sandboxInstalling = true;
        this.sandboxProgress = (evt: any) => broadcast(evt);

        const total = components.length;
        let done = 0;
        for (const c of components) {
          broadcast({ event: 'component_start', component: c, progress: Math.floor((done / total) * 100) });
          try {
            await this.installSandboxComponents([c]);
            done += 1;
            broadcast({ event: 'component_done', component: c, progress: Math.floor((done / total) * 100) });
          } catch (e: any) {
            this.ctx.logger.error('Streaming sandbox install component failed', e);
            broadcast({ event: 'error', component: c, error: (e as Error).message });
            break;
          }
        }

        const status = await this.inspectSandbox();
        broadcast({ event: 'complete', progress: 100, status });
        this.sandboxProgress = undefined;
        this.ctx.sandboxInstalling = false;
        // End all client streams gracefully
        for (const r of Array.from(this.ctx.sandboxStreamClients)) {
          try { r.raw.end(); } catch {}
          this.ctx.sandboxStreamClients.delete(r);
        }
      } catch (error) {
        this.ctx.logger.error('Sandbox streaming install failed:', error);
        this.sandboxProgress = undefined;
        this.ctx.sandboxInstalling = false;
        try { reply.code(500).send({ success: false, error: (error as Error).message }); } catch {}
      }
    });

    // Repair missing components only
    server.post('/api/sandbox/repair', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (this.ctx.sandboxInstalling) {
          return reply.code(409).send({ success: false, error: 'Sandbox installer busy', code: 'BUSY' } as any);
        }
        this.ctx.sandboxInstalling = true;
        const body = (request.body as any) || {};
        const wants: string[] = Array.isArray(body.components) && body.components.length ? body.components : ['node','python','go','packages'];
        const status = await this.inspectSandbox();
        const missing: string[] = [];
        if (wants.includes('node') && !status.nodeReady) missing.push('node');
        if (wants.includes('python') && !status.pythonReady) missing.push('python');
        if (wants.includes('go') && !status.goReady) missing.push('go');
        if (wants.includes('packages') && !status.packagesReady) missing.push('packages');
        if (missing.length === 0) {
          reply.send({ success: true, result: status, message: 'No missing components' });
          return;
        }
        const result = await this.installSandboxComponents(missing);
        reply.send({ success: true, result });
      } catch (error) {
        this.ctx.logger.error('Sandbox repair failed:', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      } finally {
        this.ctx.sandboxInstalling = false;
      }
    });

    // Cleanup leftover archives
    server.post('/api/sandbox/cleanup', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const path = await import('path');
        const fs = await import('fs/promises');
        const root = process.cwd();
        const runtimesDir = path.resolve(root, '../mcp-sandbox/runtimes');
        const dirs = ['nodejs','python','go'].map(d => path.join(runtimesDir, d));
        for (const d of dirs) {
          try {
            const items = await fs.readdir(d);
            for (const it of items) {
              if (it.endsWith('.zip') || it.endsWith('.tar.gz') || it.endsWith('.tgz')) {
                await fs.unlink(path.join(d, it)).catch(() => {});
              }
            }
          } catch {}
        }
        const status = await this.inspectSandbox();
        reply.send({ success: true, result: status });
      } catch (error) {
        this.ctx.logger.error('Sandbox cleanup failed:', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });
  }

  private writeSseHeaders(reply: FastifyReply, request: FastifyRequest): void {
    const origin = request.headers['origin'] as string | undefined;
    const config = (this.ctx.configManager as any).config || {};
    const allowed = Array.isArray(config.corsOrigins) ? config.corsOrigins : [];
    const isAllowed = origin && allowed.includes(origin);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(isAllowed ? { 'Access-Control-Allow-Origin': origin!, 'Vary': 'Origin' } : {})
    });
  }

  private async inspectSandbox() {
    const path = await import('path');
    const fs = await import('fs/promises');
    const { spawn } = await import('child_process');
    const root = process.cwd();
    const runtimesDir = path.resolve(root, '../mcp-sandbox/runtimes');
    const pkgsDir = path.resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');

    const exists = async (p: string) => { try { await fs.access(p); return true; } catch { return false; } };

    // Windows: support both node.exe at root and npm.cmd at root or under bin
    let nodeReady = false;
    if (process.platform === 'win32') {
      const nodeExe = path.join(runtimesDir, 'nodejs', 'node.exe');
      const npmCmdRoot = path.join(runtimesDir, 'nodejs', 'npm.cmd');
      const npmCmdBin = path.join(runtimesDir, 'nodejs', 'bin', 'npm.cmd');
      nodeReady = (await exists(nodeExe)) && (await exists(npmCmdRoot) || await exists(npmCmdBin));
    } else {
      const nodeBin = path.join(runtimesDir, 'nodejs', 'bin', 'node');
      const npmBin = path.join(runtimesDir, 'nodejs', 'bin', 'npm');
      nodeReady = await exists(nodeBin) && await exists(npmBin);
    }
    const pythonReady = await exists(path.join(runtimesDir, 'python', process.platform === 'win32' ? 'Scripts' : 'bin'));
    const goReady = await exists(path.join(runtimesDir, 'go', 'bin'));
    const packagesReady = await exists(path.join(pkgsDir, 'server-filesystem')) && await exists(path.join(pkgsDir, 'server-memory'));

    const details: Record<string, any> = { runtimesDir, pkgsDir };
    if (process.platform === 'win32') {
      details.nodePath = await exists(path.join(runtimesDir, 'nodejs', 'node.exe')) ? path.join(runtimesDir, 'nodejs', 'node.exe') : undefined;
      details.npmPath = await exists(path.join(runtimesDir, 'nodejs', 'npm.cmd')) ? path.join(runtimesDir, 'nodejs', 'npm.cmd')
        : (await exists(path.join(runtimesDir, 'nodejs', 'bin', 'npm.cmd')) ? path.join(runtimesDir, 'nodejs', 'bin', 'npm.cmd') : undefined);
      details.pythonPath = await exists(path.join(runtimesDir, 'python', 'python.exe')) ? path.join(runtimesDir, 'python', 'python.exe') : undefined;
      details.goPath = await exists(path.join(runtimesDir, 'go', 'bin', 'go.exe')) ? path.join(runtimesDir, 'go', 'bin', 'go.exe') : undefined;
      details.packagesDir = pkgsDir;
    } else {
      details.nodePath = await exists(path.join(runtimesDir, 'nodejs', 'bin', 'node')) ? path.join(runtimesDir, 'nodejs', 'bin', 'node') : undefined;
      details.npmPath = await exists(path.join(runtimesDir, 'nodejs', 'bin', 'npm')) ? path.join(runtimesDir, 'nodejs', 'bin', 'npm') : undefined;
      details.pythonPath = await exists(path.join(runtimesDir, 'python', 'bin', 'python3')) ? path.join(runtimesDir, 'python', 'bin', 'python3') : undefined;
      details.goPath = await exists(path.join(runtimesDir, 'go', 'bin', 'go')) ? path.join(runtimesDir, 'go', 'bin', 'go') : undefined;
      details.packagesDir = pkgsDir;
    }

    // Lightweight version probe (1s timeout)
    const getVersion = async (cmd?: string, args: string[] = [], timeoutMs = 1000): Promise<string | undefined> => {
      if (!cmd) return undefined;
      try {
        return await new Promise<string | undefined>((resolve) => {
          let settled = false;
          const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
          let out = '';
          let err = '';
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch {}
            resolve(undefined);
          }, timeoutMs);
          child.stdout?.on('data', (d) => { out += d.toString(); });
          child.stderr?.on('data', (d) => { err += d.toString(); });
          child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const text = (out || err || '').toString().trim();
            resolve(text || undefined);
          });
          child.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(undefined);
          });
        });
      } catch { return undefined; }
    };
    try { if (details.nodePath) details.nodeVersion = await getVersion(details.nodePath as string, ['-v']); } catch {}
    try { if (details.pythonPath) details.pythonVersion = await getVersion(details.pythonPath as string, ['--version']); } catch {}
    try { if (details.goPath) details.goVersion = await getVersion(details.goPath as string, ['version']); } catch {}

    this.ctx.sandboxStatus = { nodeReady, pythonReady, goReady, packagesReady, details };
    return this.ctx.sandboxStatus;
  }

  private async installSandboxComponents(components: string[]) {
    const path = await import('path');
    const fs = await import('fs/promises');
    const { spawn } = await import('child_process');
    const https = await import('https');
    const http = await import('http');
    const { createWriteStream } = await import('fs');
    const { pipeline } = await import('stream');
    const { promisify } = await import('util');
    const root = process.cwd();

    const pipelineAsync = promisify(pipeline);
    const ensureDir = async (p: string) => { try { await fs.mkdir(p, { recursive: true }); } catch {} };
    const copyDir = async (src: string, dest: string) => {
      await ensureDir(dest);
      const entries = await fs.readdir(src, { withFileTypes: true } as any);
      for (const entry of entries as any[]) {
        const s = join(src, entry.name);
        const d = join(dest, entry.name);
        if (entry.isDirectory()) {
          await copyDir(s, d);
        } else {
          await fs.copyFile(s, d).catch(async () => {
            await fs.rm(d, { force: true } as any).catch(() => {});
            await fs.copyFile(s, d);
          });
        }
      }
    };

    const run = (cmd: string, args: string[], cwd?: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
      child.on('error', reject);
    });

    const download = async (url: string, filePath: string, redirectsLeft: number = 5): Promise<void> => {
      await ensureDir(path.dirname(filePath));
      const client = url.startsWith('https') ? https : http;

      return new Promise((resolve, reject) => {
        client.get(url, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            const next = response.headers.location;
            if (!next) { reject(new Error('重定向无 Location')); return; }
            if (redirectsLeft <= 0) { reject(new Error('重定向次数过多')); return; }
            return download(next, filePath, redirectsLeft - 1).then(resolve).catch(reject);
          }
          if (response.statusCode !== 200) {
            reject(new Error(`下载失败: ${response.statusCode}`));
            return;
          }

          const fileStream = createWriteStream(filePath);
          pipelineAsync(response, fileStream)
            .then(() => resolve())
            .catch(reject);
        }).on('error', reject);
      });
    };

    const extract = async (archivePath: string, extractPath: string): Promise<void> => {
      await ensureDir(extractPath);

      if (archivePath.endsWith('.zip')) {
        if (process.platform === 'win32') {
          await run('powershell', ['-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractPath}" -Force`]);
        } else {
          try {
            await run('unzip', ['-q', '-o', archivePath, '-d', extractPath]);
          } catch {
            try {
              const dynamicImport: any = new Function('m', 'return import(m)');
              const AdmZipMod: any = await dynamicImport('adm-zip');
              const AdmZip = AdmZipMod?.default || AdmZipMod;
              const zip = new AdmZip(archivePath);
              zip.extractAllTo(extractPath, true);
            } catch (e) {
              throw new Error('无法解压 ZIP：需要 unzip 或 adm-zip');
            }
          }
        }
      } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
        try {
          await run('tar', ['-xzf', archivePath, '-C', extractPath, '--strip-components=1']);
        } catch {
          try {
            const dynamicImport: any = new Function('m', 'return import(m)');
            const tar = await dynamicImport('tar');
            await (tar as any).extract({ file: archivePath, cwd: extractPath, strip: 1 });
          } catch (e) {
            throw new Error('无法解压 TAR.GZ：需要 tar 或 npm 包 tar');
          }
        }
      }
    };

    const getRuntimeConfig = () => {
      const platform = process.platform as 'win32'|'linux'|'darwin';
      const archRaw = process.arch;
      const nodeArch = archRaw === 'arm64' ? 'arm64' : 'x64';
      const goArch = archRaw === 'arm64' ? 'arm64' : 'amd64';
      const pyArch = archRaw === 'arm64' ? 'aarch64' : 'x86_64';

      return {
        node: {
          version: 'v20.15.0',
          urls: {
            win32: `https://nodejs.org/dist/v20.15.0/node-v20.15.0-win-${nodeArch}.zip`,
            linux: `https://nodejs.org/dist/v20.15.0/node-v20.15.0-linux-${nodeArch}.tar.gz`,
            darwin: `https://nodejs.org/dist/v20.15.0/node-v20.15.0-darwin-${nodeArch}.tar.gz`
          }
        },
        python: {
          version: '3.11.9',
          urls: {
            win32: `https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-${nodeArch === 'arm64' ? 'arm64' : 'amd64'}.zip`,
            linux: `https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-${pyArch}-unknown-linux-gnu-install_only.tar.gz`,
            darwin: `https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-${pyArch}-apple-darwin-install_only.tar.gz`
          }
        },
        go: {
          version: '1.22.5',
          urls: {
            win32: `https://golang.org/dl/go1.22.5.windows-${goArch}.zip`,
            linux: `https://golang.org/dl/go1.22.5.linux-${goArch}.tar.gz`,
            darwin: `https://golang.org/dl/go1.22.5.darwin-${goArch}.tar.gz`
          }
        }
      };
    };

    const config = getRuntimeConfig();
    const platform = process.platform as 'win32' | 'linux' | 'darwin';
    const platformLabel = platform === 'win32' ? 'Windows' : (platform === 'darwin' ? 'macOS' : 'Linux');

    const logger = this.ctx.logger;
    const actions: Record<string, () => Promise<void>> = {
      async node() {
        const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
        const binDir = path.join(runtimeDir, 'bin');

        // Check if already installed
        try {
          if (platform === 'win32') {
            const nodeExe = path.join(runtimeDir, 'node.exe');
            const npmCmdRoot = path.join(runtimeDir, 'npm.cmd');
            const npmCmdBin = path.join(binDir, 'npm.cmd');
            const nodeOk = await fs.access(nodeExe).then(() => true).catch(() => false);
            const npmOk = (await fs.access(npmCmdRoot).then(() => true).catch(() => false)) || (await fs.access(npmCmdBin).then(() => true).catch(() => false));
            if (nodeOk && npmOk) {
              const st = await fs.stat(nodeExe);
              if (st.size > 1024) return;
            }
          } else {
            const nodeBin = path.join(binDir, 'node');
            const npmBin = path.join(binDir, 'npm');
            const nodeOk = await fs.access(nodeBin).then(() => true).catch(() => false);
            const npmOk = await fs.access(npmBin).then(() => true).catch(() => false);
            if (nodeOk && npmOk) {
              const st = await fs.stat(nodeBin);
              if (st.size > 1024) return;
            }
          }
        } catch {}

        const downloadUrl = config.node.urls[platform];
        const fileName = downloadUrl.split('/').pop()!;
        const archivePath = path.join(runtimeDir, fileName);

        logger.info(`下载Node.js ${config.node.version} for ${platformLabel}...`);
        await download(downloadUrl, archivePath);
        if (process.env.PB_RUNTIME_SHA256_NODE) {
          try {
            const fs = await import('fs/promises');
            const crypto = await import('crypto');
            const buf = await fs.readFile(archivePath);
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h !== process.env.PB_RUNTIME_SHA256_NODE) throw new Error('Node archive SHA256 mismatch');
          } catch (e) { throw e; }
        }

        logger.info('解压Node.js...');
        await extract(archivePath, runtimeDir);

        // Reorganize directory structure for Windows
        if (platform === 'win32') {
          const archSuffix = process.arch === 'arm64' ? 'arm64' : 'x64';
          const extractedDir = path.join(runtimeDir, `node-${config.node.version}-win-${archSuffix}`);
          if (await fs.access(extractedDir).then(() => true).catch(() => false)) {
            await ensureDir(binDir);
            const files = await fs.readdir(extractedDir);
            for (const file of files) {
              const from = path.join(extractedDir, file);
              const to = path.join(runtimeDir, file);
              try {
                await fs.rm(to, { recursive: true, force: true } as any).catch(() => {});
                await fs.rename(from, to);
              } catch (err: any) {
                if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
                  try {
                    const fsp = await import('fs/promises');
                    const stat = await fsp.stat(from);
                    if (stat.isDirectory()) {
                      await copyDir(from, to);
                      await fsp.rm(from, { recursive: true, force: true } as any);
                    } else {
                      await fsp.copyFile(from, to);
                      await fsp.unlink(from).catch(() => {});
                    }
                  } catch {}
                } else {
                  throw err;
                }
              }
            }
            await fs.rmdir(extractedDir).catch(() => {});
          }
        }

        await fs.unlink(archivePath).catch(() => {});
        logger.info('Node.js安装完成');
      },

      async python() {
        const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/python');
        const binDir = path.join(runtimeDir, platform === 'win32' ? '' : 'bin');
        const pythonBin = platform === 'win32' ? 'python.exe' : 'python3';

        try {
          const pythonPath = path.join(platform === 'win32' ? runtimeDir : binDir, pythonBin);
          await fs.access(pythonPath);
          const pythonStats = await fs.stat(pythonPath);
          if (pythonStats.size > 1024) {
            return;
          }
        } catch {}

        const downloadUrl = config.python.urls[platform];
        const fileName = downloadUrl.split('/').pop()!;
        const archivePath = path.join(runtimeDir, fileName);

        logger.info(`下载Python ${config.python.version} for ${platformLabel}...`);
        await download(downloadUrl, archivePath);
        if (process.env.PB_RUNTIME_SHA256_PYTHON) {
          try {
            const fs = await import('fs/promises');
            const crypto = await import('crypto');
            const buf = await fs.readFile(archivePath);
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h !== process.env.PB_RUNTIME_SHA256_PYTHON) throw new Error('Python archive SHA256 mismatch');
          } catch (e) { throw e; }
        }

        logger.info('解压Python...');
        await extract(archivePath, runtimeDir);

        if (platform === 'win32') {
          await ensureDir(path.join(runtimeDir, 'Scripts'));
          const pipPath = path.join(runtimeDir, 'Scripts', 'pip.exe');
          const pythonExe = path.join(runtimeDir, 'python.exe');
          await fs.writeFile(pipPath, `@echo off\n"${pythonExe}" -m pip %*`);
        }

        await fs.unlink(archivePath).catch(() => {});
        logger.info('Python安装完成');
      },

      async go() {
        const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/go');
        const binDir = path.join(runtimeDir, 'bin');
        const goBin = platform === 'win32' ? 'go.exe' : 'go';

        try {
          await fs.access(path.join(binDir, goBin));
          const goStats = await fs.stat(path.join(binDir, goBin));
          if (goStats.size > 1024) {
            return;
          }
        } catch {}

        const downloadUrl = config.go.urls[platform];
        const fileName = downloadUrl.split('/').pop()!;
        const archivePath = path.join(runtimeDir, fileName);

        logger.info(`下载Go ${config.go.version} for ${platformLabel}...`);
        await download(downloadUrl, archivePath);
        if (process.env.PB_RUNTIME_SHA256_GO) {
          try {
            const fs = await import('fs/promises');
            const crypto = await import('crypto');
            const buf = await fs.readFile(archivePath);
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h !== process.env.PB_RUNTIME_SHA256_GO) throw new Error('Go archive SHA256 mismatch');
          } catch (e) { throw e; }
        }

        logger.info('解压Go...');
        await extract(archivePath, runtimeDir);

        const extractedGoDir = path.join(runtimeDir, 'go');
        if (await fs.access(extractedGoDir).then(() => true).catch(() => false)) {
          const files = await fs.readdir(extractedGoDir);
          for (const file of files) {
            const from = path.join(extractedGoDir, file);
            const to = path.join(runtimeDir, file);
            try {
              await fs.rm(to, { recursive: true, force: true } as any).catch(() => {});
              await fs.rename(from, to);
            } catch (err: any) {
              if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
                try {
                  const stat = await fs.stat(from);
                  if (stat.isDirectory()) {
                    await copyDir(from, to);
                    await fs.rm(from, { recursive: true, force: true } as any);
                  } else {
                    await fs.copyFile(from, to);
                    await fs.unlink(from).catch(() => {});
                  }
                } catch {}
              } else {
                throw err;
              }
            }
          }
          await fs.rmdir(extractedGoDir).catch(() => {});
        }

        await fs.unlink(archivePath).catch(() => {});
        logger.info('Go安装完成');
      },

      async packages() {
        const orgDir = path.resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');
        await ensureDir(orgDir);

        const nodeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
        const nodeBin = platform === 'win32' ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node');
        let npmScript = platform === 'win32' ? (await fs.access(path.join(nodeDir, 'npm.cmd')).then(() => path.join(nodeDir, 'npm.cmd')).catch(() => path.join(nodeDir, 'bin', 'npm.cmd'))) : path.join(nodeDir, 'bin', 'npm');

        try {
          await fs.access(nodeBin);
        } catch {
          throw new Error('请先安装 Node.js 运行时');
        }

        const npmExists = await fs.access(npmScript).then(() => true).catch(() => false);
        const npmCliJs = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const installArgs = ['install', '--no-audit', '--no-fund', '@modelcontextprotocol/server-filesystem', '@modelcontextprotocol/server-memory'];
        if (npmExists) {
          await run(npmScript, installArgs, orgDir);
        } else {
          await run(nodeBin, [npmCliJs, ...installArgs], orgDir);
        }
      }
    };

    for (const c of components) {
      if (actions[c]) {
        this.ctx.logger.info(`Installing sandbox component: ${c}`);
        await actions[c]();
      }
    }

    return await this.inspectSandbox();
  }
}
