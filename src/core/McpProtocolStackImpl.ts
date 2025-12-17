import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
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
        reject(new Error(`Timeout waiting for response to message ${messageId} from ${serviceId}`));
      }, 30000);

      let buffer = '';
      const tryParseBuffer = () => {
        const trimmed = buffer.trim();
        if (!trimmed) return false;
        if (trimmed.endsWith('}')) {
          let candidate = trimmed;
          const boundary = trimmed.lastIndexOf('}{');
          if (boundary !== -1) {
            candidate = trimmed.slice(boundary + 1); // start from last '{'
          }
          try {
            const msg = JSON.parse(candidate) as McpMessage;
            if (msg && msg.id === messageId) {
              clearTimeout(timeout);
              process.stdout!.off('data', onData);
              resolve(msg);
              return true;
            }
          } catch {
            // ignore; may be partial or malformed
          }
        }
        return false;
      };
      const onData = (data: Buffer) => {
        buffer += data.toString();
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line) continue;
          try {
            const response = JSON.parse(line) as McpMessage;
            if (response && response.id === messageId) {
              clearTimeout(timeout);
              process.stdout!.off('data', onData);
              resolve(response);
              return;
            }
          } catch {
            // Ignore malformed line; continue accumulating
          }
        }
        // No newline-delimited message; attempt to parse full buffer
        tryParseBuffer();
      };

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
        reject(new Error(`Timeout waiting for message from ${serviceId}`));
      }, timeoutMs);

      let buffer = '';
      const tryParseBuffer = () => {
        const trimmed = buffer.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const msg = JSON.parse(trimmed) as McpMessage;
            // Ignore handshake/no-id messages
            if ((msg as any).id !== undefined || (msg as any).method) {
              clearTimeout(timeout);
              process.stdout!.off('data', onData);
              resolve(msg);
              return true;
            }
          } catch {
            // If looks like a full object but malformed, reject fast
            clearTimeout(timeout);
            process.stdout!.off('data', onData);
            reject(new Error('Malformed JSON message'));
            return true;
          }
        }
        return false;
      };
      const onData = (data: Buffer) => {
        buffer += data.toString();
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line) continue;
          try {
            const message = JSON.parse(line) as McpMessage;
            clearTimeout(timeout);
            process.stdout!.off('data', onData);
            resolve(message);
            return;
          } catch {
            // Ignore and continue reading further lines
          }
        }
        // attempt parse for single-object buffer without newline
        tryParseBuffer();
      };

      process.stdout?.on('data', onData);
    });
  }

  async negotiateVersion(serviceId: string, versions: McpVersion[]): Promise<McpVersion> {
    return this.handshaker.negotiateVersion(serviceId, versions);
  }

  async getCapabilities(serviceId: string): Promise<Record<string, any>> {
    const negotiatedVersion = await this.negotiateVersion(serviceId, [...MCP_VERSIONS]);
    const initMessage: McpMessage = {
      jsonrpc: '2.0',
      id: Date.now(),
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

    return response.result?.capabilities || {};
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

      // Cleanup on failure
      await this.cleanupProcess(serviceId);

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

        process.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      await this.cleanupProcess(serviceId);

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

  private buildSandboxEnv(baseEnv: NodeJS.ProcessEnv, overrideEnv: Record<string, any> = {}): NodeJS.ProcessEnv {
    try {
      if (overrideEnv && String(overrideEnv.SANDBOX) === 'portable') {
        const path = require('path');
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

        // Merge user overrides last
        for (const [k, v] of Object.entries(overrideEnv)) {
          (patched as any)[k] = String(v);
        }
        return patched;
      }
    } catch { /* ignored */ }
    return { ...baseEnv, ...overrideEnv };
  }

  private inferPortableCwd(workingDirectory?: string, args: string[] = [], env: Record<string, any> = {}): string | undefined {
    if (workingDirectory) return workingDirectory;
    if (!(env && String(env.SANDBOX) === 'portable')) return undefined;
    // If using npm exec <pkg>, set cwd to portable package dir so exec resolves locally
    const pkg = args.find(a => typeof a === 'string' && a.startsWith('@modelcontextprotocol/'));
    if (!pkg) return undefined;
    try {
      const pathMod = require('path');
      const resolve = pathMod.resolve;
      const _join = pathMod.join;
      // packages installed under mcp-sandbox/packages/@modelcontextprotocol/server-*
      const pkgDir = resolve(process.cwd(), '../mcp-sandbox/packages', pkg);
      return pkgDir;
    } catch {
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

  private async cleanupProcess(serviceId: string): Promise<void> {
    // Remove from maps
    this.instances.delete(serviceId);
    this.processes.delete(serviceId);

    // Cleanup state manager
    this.stateManager.removeService(serviceId);
  }

  // Event system
  on(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(event, listener);
  }
}
