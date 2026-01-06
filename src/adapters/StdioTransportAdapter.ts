import { spawn, ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { TransportAdapter, McpServiceConfig, McpMessage, Logger, McpVersion } from '../types/index.js';
import { EventEmitter } from 'events';
import { JsonRpcStreamParser } from '../core/JsonRpcStreamParser.js';

function stripNpmVersion(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('.') || trimmed.startsWith('/') || trimmed.startsWith('file:') || trimmed.startsWith('git+')) return trimmed;

  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/');
    if (slash < 0) return trimmed;
    const lastAt = trimmed.lastIndexOf('@');
    if (lastAt > slash) return trimmed.slice(0, lastAt);
    return trimmed;
  }

  const at = trimmed.indexOf('@');
  if (at > 0) return trimmed.slice(0, at);
  return trimmed;
}

function extractNpmExecPackage(args: string[]): string | undefined {
  const idx = args.indexOf('exec');
  if (idx < 0) return undefined;

  for (let i = idx + 1; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token) continue;

    if (token === '--package' || token === '-p') {
      const next = String(args[i + 1] ?? '');
      if (next) return stripNpmVersion(next);
      continue;
    }
    if (token.startsWith('--package=')) return stripNpmVersion(token.slice('--package='.length));

    if (token.startsWith('-')) continue;
    return stripNpmVersion(token);
  }

  return undefined;
}

function extractNpxPackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token) continue;

    if (token === '--package' || token === '-p') {
      const next = String(args[i + 1] ?? '');
      if (next) return stripNpmVersion(next);
      continue;
    }
    if (token.startsWith('--package=')) return stripNpmVersion(token.slice('--package='.length));
    if (token.startsWith('-')) continue;
    return stripNpmVersion(token);
  }
  return undefined;
}

function inferPortablePackagesDir(pkg?: string): string | undefined {
  if (!pkg) return undefined;
  const cleaned = stripNpmVersion(pkg);
  if (!cleaned) return undefined;

  const packagesRoot = path.resolve(process.cwd(), '../mcp-sandbox/packages');
  if (cleaned.startsWith('@') && cleaned.includes('/')) {
    const scope = cleaned.split('/')[0] as string;
    return path.join(packagesRoot, scope);
  }
  return packagesRoot;
}

function isWithinPath(targetPath: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, targetPath);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export class StdioTransportAdapter extends EventEmitter implements TransportAdapter {
  readonly type = 'stdio' as const;
  readonly version: McpVersion;

  private process: ChildProcess | null = null;
  private connected = false;
  private readonly stdoutParser = new JsonRpcStreamParser<McpMessage>({
    onError: (error, context) => {
      this.logger.warn(`Failed to parse stdio JSON-RPC frame`, {
        error: String(error?.message || error),
        rawLength: context.raw?.length
      });
    }
  });
  private messageQueue: McpMessage[] = [];
  private responseCallbacks = new Map<string | number, {
    resolve: (value: McpMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private config: McpServiceConfig,
    private logger: Logger
  ) {
    super();
    this.version = config.version;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const { command, args = [], env = {}, workingDirectory } = this.config;

    if (!command) {
      throw new Error('Command is required for stdio transport');
    }

    try {
      // Normalize command for Windows (npm -> npm.cmd, npx -> npx.cmd, etc.)
      let normalizedCommand = command;
      if (process.platform === 'win32') {
        const baseName = path.basename(command).toLowerCase();
        if (['npm', 'npx', 'node'].includes(baseName) && !baseName.endsWith('.cmd') && !baseName.endsWith('.exe')) {
          // For npm/npx, add .cmd; for node, add .exe
          normalizedCommand = baseName === 'node' ? command + '.exe' : command + '.cmd';
        }
      }

      this.logger.debug(`Starting stdio process: ${normalizedCommand} ${args.join(' ')}`);

      // Basic command allowlist to reduce injection surface when shell=true (Windows)
      const ALLOWED_COMMANDS = new Set([
        'node', 'node.exe',
        'npx', 'npx.cmd',
        'npm', 'npm.cmd',
        'python', 'python.exe',
        'python3', 'python3.exe',
        'deno', 'deno.exe',
        // Container runtimes (used by ContainerTransportAdapter)
        'docker', 'docker.exe',
        'podman', 'podman.exe'
      ]);
      const baseCmd = path.basename(normalizedCommand).toLowerCase().replace(/\\/g, '/');
      if (process.platform === 'win32' && !ALLOWED_COMMANDS.has(baseCmd)) {
        throw new Error(`Command not allowed: ${baseCmd}`);
      }

      // Validate working directory stays within project cwd
      let effectiveWorkingDirectory = workingDirectory;
      const sandboxMode = String((env as any)?.SANDBOX || '');
      const isPortableSandbox = sandboxMode === 'portable';

      // Infer portable packages directory when running npm/npx under SANDBOX=portable.
      if (!effectiveWorkingDirectory && isPortableSandbox) {
        const baseCmd = path.basename(normalizedCommand).toLowerCase().replace(/\\/g, '/');
        const cmdBase = baseCmd.replace(/\.(exe|cmd|bat|com)$/i, '');
        if (cmdBase === 'npx') {
          const pkg = extractNpxPackage(args);
          effectiveWorkingDirectory = inferPortablePackagesDir(pkg);
        } else if (cmdBase === 'npm' && args.includes('exec')) {
          const pkg = extractNpmExecPackage(args);
          effectiveWorkingDirectory = inferPortablePackagesDir(pkg);
        }
      }

      if (effectiveWorkingDirectory) {
        const resolved = path.resolve(effectiveWorkingDirectory);
        const projectRoot = path.resolve(process.cwd());
        const allowedSandboxRoot = path.resolve(process.cwd(), '../mcp-sandbox');
        const allowedDataRoot = path.resolve(process.cwd(), './data');

        const allowed = isWithinPath(resolved, projectRoot) || (isPortableSandbox && (
          isWithinPath(resolved, allowedSandboxRoot) || isWithinPath(resolved, allowedDataRoot)
        ));

        if (!allowed) {
          throw new Error('Working directory outside allowed path');
        }
      }

      // On Windows, default to shell=false; allow opt-in when needed
      const useShell = process.platform === 'win32' && (String(env?.USE_SHELL) === '1');

      const processEnv = this.buildIsolatedEnv(process.env, env);

      const opts: any = {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: processEnv,
        shell: useShell
      };
      // Pass cwd for portable sandbox and explicit opt-in.
      if (effectiveWorkingDirectory && (isPortableSandbox || String(env?.USE_CWD) === '1')) {
        opts.cwd = effectiveWorkingDirectory;

        // When offline is enforced, require installed packages + lockfile under the sandbox directory.
        const offline = String((env as any)?.npm_config_offline || '') === 'true' || args.includes('--no-install');
        if (isPortableSandbox && offline) {
          const baseCmd = path.basename(normalizedCommand).toLowerCase().replace(/\\/g, '/');
          const cmdBase = baseCmd.replace(/\.(exe|cmd|bat|com)$/i, '');
          const pkg = cmdBase === 'npx' ? extractNpxPackage(args) : extractNpmExecPackage(args);
          if (pkg) {
            const pkgName = stripNpmVersion(pkg);
            const parts = pkgName.startsWith('@') ? pkgName.split('/') : [pkgName];
            const pkgDir = path.join(effectiveWorkingDirectory, 'node_modules', ...parts);

            const hasLock = async () => {
              try { await fs.access(path.join(effectiveWorkingDirectory, 'package-lock.json')); return true; } catch {}
              try { await fs.access(path.join(effectiveWorkingDirectory, 'npm-shrinkwrap.json')); return true; } catch {}
              return false;
            };

            const [pkgOk, lockOk] = await Promise.all([
              fs.access(pkgDir).then(() => true).catch(() => false),
              hasLock()
            ]);

            if (!lockOk || !pkgOk) {
              throw new Error(
                `Portable sandbox requires locked, preinstalled npm deps. Missing ${!lockOk ? 'lockfile' : 'package'} for ${pkgName} under ${effectiveWorkingDirectory}. ` +
                `Install via /api/sandbox/install or run "npm install ${pkgName}" in that directory.`
              );
            }
          }
        }
      }

      this.process = spawn(normalizedCommand, args, opts);

      if (!this.process.pid) {
        throw new Error(`Failed to start process: ${command}`);
      }

      this.setupProcessHandlers();

      // Wait for process to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Process startup timeout'));
        }, 10000);

        const onError = (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        };

        const onReady = () => {
          clearTimeout(timeout);
          this.process!.off('error', onError);
          resolve();
        };

        this.process!.once('error', onError);

        // Consider process ready when stdout is available
        if (this.process!.stdout) {
          onReady();
        }
      });

      this.connected = true;
      this.logger.info(`Stdio adapter connected for ${this.config.name}`);
    } catch (error) {
      this.logger.error(`Failed to connect stdio adapter:`, error);
      throw error;
    }
  }

  private buildIsolatedEnv(baseEnv: NodeJS.ProcessEnv, overrideEnv: Record<string, any> = {}): NodeJS.ProcessEnv {
    // Optional lightweight sandbox when SANDBOX === 'portable'
    if (overrideEnv && overrideEnv.SANDBOX === 'portable') {
      const portableNodeDir = overrideEnv.SANDBOX_NODE_DIR
        || path.resolve(process.cwd(), '../mcp-sandbox/runtimes/nodejs');
      const portablePythonDir = overrideEnv.SANDBOX_PYTHON_DIR
        || path.resolve(process.cwd(), '../mcp-sandbox/runtimes/python');
      const portableGoDir = overrideEnv.SANDBOX_GO_DIR
        || path.resolve(process.cwd(), '../mcp-sandbox/runtimes/go');

      const nodeBinPrimary = process.platform === 'win32'
        ? portableNodeDir
        : path.join(portableNodeDir, 'bin');
      const nodeBinAlt = process.platform === 'win32'
        ? path.join(portableNodeDir, 'bin')
        : portableNodeDir;
      const pythonBinPrimary = path.join(portablePythonDir, process.platform === 'win32' ? 'Scripts' : 'bin');
      const pythonBinAlt = process.platform === 'win32' ? path.join(portablePythonDir) : path.join(portablePythonDir, 'Scripts');
      const goBin = path.join(portableGoDir, 'bin');

      const sanitized: NodeJS.ProcessEnv = {
        // Minimal required vars (Windows)
        SYSTEMROOT: baseEnv.SYSTEMROOT,
        WINDIR: baseEnv.WINDIR,
        USERPROFILE: baseEnv.USERPROFILE,
        TEMP: baseEnv.TEMP,
        TMP: baseEnv.TMP,
        // Prepend portable runtimes to PATH (node/python/go)
        PATH: [
          nodeBinPrimary,
          nodeBinAlt,
          pythonBinPrimary,
          pythonBinAlt,
          goBin,
          baseEnv.PATH || ''
        ].filter(Boolean).join(path.delimiter),
        // Force NPM to ignore engine checks and prefer offline cache if available
        npm_config_engine_strict: 'false',
        npm_config_force: 'true',
        npm_config_prefer_offline: 'true',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        // Golang specific (best-effort)
        GOROOT: portableGoDir,
        GOPATH: overrideEnv.SANDBOX_GOPATH || path.resolve(process.cwd(), '../mcp-sandbox/go'),
        GOBIN: overrideEnv.SANDBOX_GOBIN || path.join(path.resolve(process.cwd(), '../mcp-sandbox/go'), 'bin'),
        // Disable common proxy envs (avoid unexpected external proxies)
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1'
      };

      // Merge user-provided environment overrides last
      for (const [k, v] of Object.entries(overrideEnv)) {
        sanitized[k] = String(v);
      }

      return sanitized;
    }

    // Default: inherit environment and apply overrides
    return { ...baseEnv, ...overrideEnv };
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.process) {
      return;
    }

    try {
      // Clear all pending callbacks
      for (const [_id, callback] of this.responseCallbacks) {
        clearTimeout(callback.timeout);
        callback.reject(new Error('Connection closed'));
      }
      this.responseCallbacks.clear();

      // Graceful shutdown
      this.process.kill('SIGTERM');

      // Force kill after timeout
      const forceKillTimeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);

      await new Promise<void>((resolve) => {
        if (!this.process) {
          resolve();
          return;
        }

        this.process.on('exit', () => {
          clearTimeout(forceKillTimeout);
          resolve();
        });
      });

      this.connected = false;
      this.process = null;
      this.stdoutParser.reset();
      this.logger.info(`Stdio adapter disconnected for ${this.config.name}`);
    } catch (error) {
      this.logger.error(`Error disconnecting stdio adapter:`, error);
      throw error;
    }
  }

  async send(message: McpMessage): Promise<void> {
    if (!this.connected || !this.process || !this.process.stdin) {
      throw new Error('Adapter not connected');
    }

    try {
      const messageStr = JSON.stringify(message) + '\n';
      this.process.stdin.write(messageStr);
      this.logger.trace(`Sent message via stdio:`, message);
      // Emit for external observers (e.g., HTTP layer log pipeline)
      this.emit('sent', message);
    } catch (error) {
      this.logger.error(`Failed to send message via stdio:`, error);
      throw error;
    }
  }

  async receive(): Promise<McpMessage> {
    if (!this.connected) {
      throw new Error('Adapter not connected');
    }

    // If there are queued messages, return the first one
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    // Wait for next message
    return new Promise<McpMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Receive timeout'));
      }, this.config.timeout || 30000);

      const onMessage = (message: McpMessage) => {
        clearTimeout(timeout);
        this.off('message', onMessage);
        resolve(message);
      };

      this.on('message', onMessage);
    });
  }

  isConnected(): boolean {
    return this.connected && this.process !== null && !this.process.killed;
  }

  // Send a message and wait for response with matching ID
  async sendAndReceive(message: McpMessage): Promise<McpMessage> {
    if (!message.id) {
      message.id = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    return new Promise<McpMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responseCallbacks.delete(message.id!);
        reject(new Error(`Request timeout for message ${message.id}`));
      }, this.config.timeout || 30000);

      this.responseCallbacks.set(message.id!, {
        resolve,
        reject,
        timeout
      });

      this.send(message).catch(reject);
    });
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on('error', (error: any) => {
      this.logger.error(`Stdio process error:`, error);
      // Try to surface common env missing patterns to upstream (for UI hints)
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('required') || msg.includes('not set') || msg.includes('environment variable')) {
        this.emit('stderr', `env-error: ${error.message}`);
      }
      this.emit('error', error);
    });

    this.process.on('exit', (code, signal) => {
      this.logger.info(`Stdio process exited`, { code, signal });
      this.connected = false;
      this.emit('disconnect', { code, signal });
    });

    // Stream stderr line-by-line and expose as events
    if (this.process.stderr) {
      let stderrBuffer = '';
      this.process.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        let newlineIndex: number;
        while ((newlineIndex = stderrBuffer.indexOf('\n')) !== -1) {
          const line = stderrBuffer.slice(0, newlineIndex).trim();
          stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
          if (line) {
            this.logger.warn(`Stdio stderr:`, line);
            // Emit parsed hint for missing env variables (e.g., "BRAVE_API_KEY environment variable is required")
            const lower = line.toLowerCase();
            if (lower.includes('environment variable is required') || lower.includes('not set') || /\b(api[_-]?key|token|secret)\b/.test(lower)) {
              this.emit('stderr', `env-hint: ${line}`);
            }
            this.emit('stderr', line);
          }
        }
      });
    }

    // Handle stdout messages
    if (this.process.stdout) {
      this.stdoutParser.reset();
      this.process.stdout.on('data', (data) => {
        const messages = this.stdoutParser.push(data);
        for (const message of messages) {
          if (!message || typeof message !== 'object') continue;
          this.handleMessage(message);
        }
      });
    }
  }

  private handleMessage(message: McpMessage): void {
    this.logger.trace(`Received message via stdio:`, message);

    // Check if this is a response to a pending request
    if (message.id && this.responseCallbacks.has(message.id)) {
      const callback = this.responseCallbacks.get(message.id)!;
      this.responseCallbacks.delete(message.id);
      clearTimeout(callback.timeout);
      callback.resolve(message);
      return;
    }

    // Handle notifications and requests
    if (!message.id || message.method) {
      // This is a notification or request from the server
      this.emit('message', message);
      this.messageQueue.push(message);
    } else {
      // Response without matching request - queue it
      this.messageQueue.push(message);
      this.emit('message', message);
    }
  }
}
