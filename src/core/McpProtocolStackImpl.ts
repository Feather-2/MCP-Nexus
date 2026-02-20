import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'node:path';
import {
  McpProtocolStack,
  McpServiceConfig,
  ServiceInstance,
  McpMessage,
  McpVersion,
  
  Logger,
  MCP_VERSIONS
} from '../types/index.js';
import { ProcessStateManager } from './ProcessStateManager.js';
import { McpProtocolHandshaker } from './McpProtocolHandshaker.js';
import { UnifiedErrorHandler } from '../utils/ErrorHandler.js';
import { JsonRpcStreamParser } from './JsonRpcStreamParser.js';
import { CommandValidator } from '../security/command-validator.js';

const commandValidator = new CommandValidator({ allowShellMeta: false });

export class McpProtocolStackImpl implements McpProtocolStack {
  private instances = new Map<string, ServiceInstance>();
  private processes = new Map<string, ChildProcess>();
  private stateManager: ProcessStateManager;
  private handshaker: McpProtocolHandshaker;
  private errorHandler: UnifiedErrorHandler;
  private eventEmitter = new EventEmitter();

  constructor(private logger: Logger) {
    this.stateManager = new ProcessStateManager(logger);
    this.handshaker = new McpProtocolHandshaker(logger);
    this.errorHandler = new UnifiedErrorHandler(logger);
  }

  async sendMessage(serviceId: string, message: McpMessage): Promise<McpMessage> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Service ${serviceId} not found`);
    }

    const process = this.processes.get(serviceId);
    if (!process || !process.stdin) {
      throw new Error(`Service ${serviceId} process not available`);
    }

    try {
      // Send message via stdin
      const messageStr = JSON.stringify(message) + '\n';
      process.stdin.write(messageStr);

      // For requests with ID, wait for response
      if (message.id && message.method) {
        return await this.waitForResponse(serviceId, message.id);
      } else {
        // For notifications, return immediately
        return message;
      }
    } catch (error) {
      this.errorHandler.handleError(error as Error, { serviceId, message });
      throw error;
    }
  }

  private async waitForResponse(serviceId: string, messageId: string | number): Promise<McpMessage> {
    const process = this.processes.get(serviceId);
    if (!process || !process.stdout) {
      throw new Error(`Service ${serviceId} process not available`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.stdout!.off('data', onData);
        process.off('exit', onExit);
        reject(new Error(`Timeout waiting for response to message ${messageId} from ${serviceId}`));
      }, 30000);
      (timeout as unknown as { unref?: () => void }).unref?.();

      const parser = new JsonRpcStreamParser<McpMessage>({
        onError: () => {
          // ignore parse errors and keep waiting for the matching response
        }
      });

      const onExit = () => {
        clearTimeout(timeout);
        process.stdout!.off('data', onData);
        reject(new Error(`Process exited while waiting for response ${messageId} from ${serviceId}`));
      };

      const onData = (data: Buffer) => {
        const messages = parser.push(data);
        for (const msg of messages) {
          if (msg && msg.id === messageId) {
            clearTimeout(timeout);
            process.stdout!.off('data', onData);
            process.off('exit', onExit);
            resolve(msg);
            return;
          }
        }
      };

      process.once('exit', onExit);
      process.stdout?.on('data', onData);
    });
  }

  async receiveMessage(serviceId: string, timeoutMs = 30000): Promise<McpMessage> {
    const process = this.processes.get(serviceId);
    if (!process || !process.stdout) {
      throw new Error(`Service ${serviceId} process not available`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.stdout!.off('data', onData);
        process.off('exit', onExit);
        reject(new Error(`Timeout waiting for message from ${serviceId}`));
      }, timeoutMs);
      (timeout as unknown as { unref?: () => void }).unref?.();

      const parser = new JsonRpcStreamParser<McpMessage>({
        throwOnParseError: true
      });

      const onExit = () => {
        clearTimeout(timeout);
        process.stdout!.off('data', onData);
        reject(new Error(`Process exited while waiting for message from ${serviceId}`));
      };

      const onData = (data: Buffer) => {
        try {
          const messages = parser.push(data);
          for (const message of messages) {
            if (!message) continue;
            // Ignore handshake/no-id messages (compat with previous behavior)
            if ((message as unknown as Record<string, unknown>).id === undefined && !(message as unknown as Record<string, unknown>).method) continue;
            clearTimeout(timeout);
            process.stdout!.off('data', onData);
            process.off('exit', onExit);
            resolve(message);
            return;
          }
        } catch (error) {
          clearTimeout(timeout);
          process.stdout!.off('data', onData);
          process.off('exit', onExit);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      process.once('exit', onExit);
      process.stdout?.on('data', onData);
    });
  }

  async negotiateVersion(serviceId: string, versions: McpVersion[]): Promise<McpVersion> {
    return this.handshaker.negotiateVersion(serviceId, versions);
  }

  async getCapabilities(serviceId: string): Promise<Record<string, unknown>> {
    const negotiatedVersion = await this.negotiateVersion(serviceId, [...MCP_VERSIONS]);
    const initMessage: McpMessage = {
      jsonrpc: '2.0',
      id: `init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: 'initialize',
      params: {
        protocolVersion: negotiatedVersion,
        capabilities: {},
        clientInfo: {
          name: 'MCP-Nexus',
          version: '1.0.0'
        }
      }
    };

    const response = await this.sendMessage(serviceId, initMessage);

    if (response.error) {
      throw new Error(`Failed to get capabilities: ${response.error.message}`);
    }

    return (response.result as Record<string, unknown>)?.capabilities as Record<string, unknown> || {};
  }

  async startProcess(config: McpServiceConfig): Promise<ServiceInstance> {
    const serviceId = `${config.name}-${Date.now()}`;

    try {
      // Create service instance
      const instance: ServiceInstance = {
        id: serviceId,
        config,
        state: 'initializing',
        startTime: new Date(),
        startedAt: new Date(),
        errorCount: 0,
        metadata: {}
      };

      this.instances.set(serviceId, instance);
      this.stateManager.updateState(serviceId, 'initializing');

      // Start the process
      const process = await this.spawnProcess(config);
      this.processes.set(serviceId, process);

      // Set up process event handlers
      this.setupProcessHandlers(serviceId, process);

      // Update state to starting
      this.stateManager.updateState(serviceId, 'starting');
      instance.state = 'starting';
      instance.pid = process.pid;

      // Perform MCP handshake
      await this.performHandshake(serviceId);

      // Update to running state
      this.stateManager.updateState(serviceId, 'running');
      instance.state = 'running';

      this.logger.info(`Service ${serviceId} started successfully`, {
        config: config.name,
        pid: process.pid
      });

      this.eventEmitter.emit('service-started', { serviceId, instance });

      return instance;
    } catch (error) {
      this.errorHandler.handleError(error as Error, { serviceId, config });

      // Cleanup on failure — kill orphaned process
      await this.cleanupProcess(serviceId, true);

      throw error;
    }
  }

  async stopProcess(serviceId: string): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Service ${serviceId} not found`);
    }

    const process = this.processes.get(serviceId);
    if (!process) {
      throw new Error(`Process for service ${serviceId} not found`);
    }

    try {
      this.stateManager.updateState(serviceId, 'stopping');
      instance.state = 'stopping';

      // Send graceful shutdown signal
      process.kill('SIGTERM');

      // Wait for graceful shutdown or force kill after timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          process.kill('SIGKILL');
          resolve();
        }, 5000);
        // Don't keep the Node process alive solely for this fallback kill timer
        (timeout as unknown as { unref?: () => void }).unref?.();

        process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      await this.cleanupProcess(serviceId, false);

      this.logger.info(`Service ${serviceId} stopped successfully`);
      this.eventEmitter.emit('service-stopped', { serviceId });
    } catch (error) {
      this.errorHandler.handleError(error as Error, { serviceId });
      throw error;
    }
  }

  async restartProcess(serviceId: string): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Service ${serviceId} not found`);
    }

    this.logger.info(`Restarting service ${serviceId}`);

    try {
      await this.stopProcess(serviceId);
      await this.startProcess(instance.config);
    } catch (error) {
      this.errorHandler.handleError(error as Error, { serviceId, action: 'restart' });
      throw error;
    }
  }

  async getProcessInfo(serviceId: string): Promise<ServiceInstance | null> {
    return this.instances.get(serviceId) || null;
  }

  private async spawnProcess(config: McpServiceConfig): Promise<ChildProcess> {
    const { command, args = [], env = {}, workingDirectory } = config;

    if (!command) {
      throw new Error('Command is required for stdio transport');
    }

    // Build portable SANDBOX env if requested
    const processEnv = this.buildSandboxEnv({ ...process.env }, env);

    // Prefer installed offline packages directory when SANDBOX is enabled and using npm exec
    const effectiveCwd = this.inferPortableCwd(workingDirectory, args, env);

    // Validate command against security blocklist
    try {
      commandValidator.validate(command);
    } catch (e: unknown) {
      throw new Error(`Command blocked by security policy: ${(e as Error)?.message || String(e)}`);
    }

    const childProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: processEnv,
      cwd: effectiveCwd,
      // Default shell=false for better safety/stability; allow opt-in via USE_SHELL=1
      shell: process.platform === 'win32' && String(env?.USE_SHELL) === '1'
    });

    if (!childProcess.pid) {
      throw new Error(`Failed to start process: ${command}`);
    }

    return childProcess;
  }

  private buildSandboxEnv(baseEnv: NodeJS.ProcessEnv, overrideEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
    try {
      if (overrideEnv && String(overrideEnv.SANDBOX) === 'portable') {
        const resolve = path.resolve.bind(path);
        const join = path.join.bind(path);

        const portableNodeDir = overrideEnv.SANDBOX_NODE_DIR || resolve(process.cwd(), '../mcp-sandbox/runtimes/nodejs');
        const portablePythonDir = overrideEnv.SANDBOX_PYTHON_DIR || resolve(process.cwd(), '../mcp-sandbox/runtimes/python');
        const portableGoDir = overrideEnv.SANDBOX_GO_DIR || resolve(process.cwd(), '../mcp-sandbox/runtimes/go');

        const nodeBin = join(portableNodeDir, 'bin');
        const pythonBinPrimary = join(portablePythonDir, process.platform === 'win32' ? 'Scripts' : 'bin');
        const pythonBinAlt = process.platform === 'win32' ? portablePythonDir : join(portablePythonDir, 'Scripts');
        const goBin = join(portableGoDir, 'bin');

        const patched: NodeJS.ProcessEnv = {
          ...baseEnv,
          // Prepend portable runtimes to PATH
          PATH: [nodeBin, pythonBinPrimary, pythonBinAlt, goBin, baseEnv.PATH || ''].filter(Boolean).join(path.delimiter),
          // npm relaxed/offline friendly
          npm_config_engine_strict: 'false',
          npm_config_force: 'true',
          npm_config_prefer_offline: 'true',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          // Go envs (best-effort)
          GOROOT: portableGoDir,
          GOPATH: overrideEnv.SANDBOX_GOPATH || resolve(process.cwd(), '../mcp-sandbox/go'),
          GOBIN: overrideEnv.SANDBOX_GOBIN || join(resolve(process.cwd(), '../mcp-sandbox/go'), 'bin'),
          // Proxy hardened
          HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
          NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1'
        };

        // Merge user overrides, but protect sandbox-critical keys from being overridden
        const SANDBOX_PROTECTED_KEYS = new Set([
          'PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
          'NO_PROXY', 'no_proxy', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES'
        ]);
        for (const [k, v] of Object.entries(overrideEnv)) {
          if (SANDBOX_PROTECTED_KEYS.has(k)) continue;
          (patched as Record<string, string>)[k] = String(v);
        }
        return patched;
      }
    } catch (e) {
      this.logger.warn('Failed to build portable env', { error: (e as Error).message });
    }
    // Fallback: return base env only — do NOT merge unprotected overrides
    return { ...baseEnv };
  }

  private inferPortableCwd(workingDirectory?: string, args: string[] = [], env: Record<string, string> = {}): string | undefined {
    if (workingDirectory) return workingDirectory;
    if (!(env && String(env.SANDBOX) === 'portable')) return undefined;
    // If using npm exec <pkg>, set cwd to portable package dir so exec resolves locally
    const pkg = args.find(a => typeof a === 'string' && a.startsWith('@modelcontextprotocol/'));
    if (!pkg) return undefined;
    try {
      // packages installed under mcp-sandbox/packages/@modelcontextprotocol/server-*
      const pkgDir = path.resolve(process.cwd(), '../mcp-sandbox/packages', pkg);
      return pkgDir;
    } catch (e) {
      this.logger.warn('Failed to infer portable cwd', { error: (e as Error).message });
      return undefined;
    }
  }

  private setupProcessHandlers(serviceId: string, process: ChildProcess): void {
    process.on('error', (error) => {
      this.logger.error(`Process error for ${serviceId}:`, error);
      this.handleProcessError(serviceId, error);
    });

    process.on('exit', (code, signal) => {
      this.logger.info(`Process ${serviceId} exited`, { code, signal });
      this.handleProcessExit(serviceId, code, signal);
    });

    process.stderr?.on('data', (data) => {
      this.logger.warn(`Stderr from ${serviceId}:`, data.toString());
    });
  }

  private async performHandshake(serviceId: string): Promise<void> {
    try {
      await this.handshaker.performHandshake(serviceId, this);
    } catch (error) {
      throw new Error(`Handshake failed for ${serviceId}: ${error}`);
    }
  }

  private handleProcessError(serviceId: string, error: Error): void {
    const instance = this.instances.get(serviceId);
    if (instance) {
      instance.state = 'error';
      instance.errorCount++;
      this.stateManager.updateState(serviceId, 'error');
      this.eventEmitter.emit('service-error', { serviceId, error });
    }
  }

  private handleProcessExit(serviceId: string, code: number | null, signal: string | null): void {
    const instance = this.instances.get(serviceId);
    if (instance) {
      if (code === 0) {
        instance.state = 'stopped';
        this.stateManager.updateState(serviceId, 'stopped');
      } else {
        instance.state = 'crashed';
        instance.errorCount++;
        this.stateManager.updateState(serviceId, 'crashed');
      }

      this.eventEmitter.emit('service-stopped', { serviceId, code, signal });
    }
  }

  private async cleanupProcess(serviceId: string, killOrphan = false): Promise<void> {
    const proc = this.processes.get(serviceId);
    if (killOrphan) {
      if (proc && !proc.killed && proc.exitCode == null) {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }
    if (proc) {
      proc.removeAllListeners();
      proc.stderr?.removeAllListeners();
    }
    // Remove from maps
    this.instances.delete(serviceId);
    this.processes.delete(serviceId);

    // Cleanup state manager
    this.stateManager.removeService(serviceId);
  }

  // Event system
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.off(event, listener);
  }
}
