import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { TransportAdapter, McpServiceConfig, McpMessage, Logger, McpVersion } from '../types/index.js';
import { EventEmitter } from 'events';

export class StdioTransportAdapter extends EventEmitter implements TransportAdapter {
  readonly type = 'stdio' as const;
  readonly version: McpVersion;

  private process: ChildProcess | null = null;
  private connected = false;
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
      this.logger.debug(`Starting stdio process: ${command} ${args.join(' ')}`);

      // On Windows, always use shell to resolve npm/npx reliably (even with portable sandbox)
      const useShell = process.platform === 'win32';

      const processEnv = this.buildIsolatedEnv(process.env, env);

      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: processEnv,
        cwd: workingDirectory,
        shell: useShell
      });

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
      for (const [id, callback] of this.responseCallbacks) {
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

    this.process.on('error', (error) => {
      this.logger.error(`Stdio process error:`, error);
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
            this.emit('stderr', line);
          }
        }
      });
    }

    // Handle stdout messages
    if (this.process.stdout) {
      let buffer = '';

      this.process.stdout.on('data', (data) => {
        buffer += data.toString();

        // Process complete JSON messages (newline-delimited)
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const messageStr = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (messageStr) {
            try {
              const message = JSON.parse(messageStr) as McpMessage;
              this.handleMessage(message);
            } catch (error) {
              this.logger.warn(`Failed to parse message:`, { messageStr, error });
            }
          }
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
