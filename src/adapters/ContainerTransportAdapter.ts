import { EventEmitter } from 'events';
import path from 'path';
import { McpServiceConfig, McpMessage, Logger, McpVersion, TransportAdapter } from '../types/index.js';
import { StdioTransportAdapter } from './StdioTransportAdapter.js';

/**
 * ContainerTransportAdapter
 * - Runs the MCP server inside a container (docker/podman) and communicates via stdio.
 * - Does not introduce a new transport type; presents as 'stdio' to upper layers.
 * - Container selection is triggered by config.env.SANDBOX === 'container' or config.container being present.
 */
export class ContainerTransportAdapter extends EventEmitter implements TransportAdapter {
  readonly type = 'stdio' as const; // Keep stdio to match TransportType union
  readonly version: McpVersion;

  private delegate: StdioTransportAdapter;

  constructor(private config: McpServiceConfig, private logger: Logger) {
    super();
    this.version = config.version;

    // Build container command & args
    const { command: innerCmd, args: innerArgs = [], env = {} } = config;
    const container = (config as any).container || {};

    const runtime: 'docker' | 'podman' = (container.runtime as any) || (process.env.CONTAINER_RUNTIME as any) || 'docker';
    const image: string | undefined = container.image;

    if (!image) {
      throw new Error('Container image is required when SANDBOX=container or container config is present');
    }

    const runArgs: string[] = ['run', '--rm', '-i'];

    // readonly rootfs
    if (container.readonlyRootfs) runArgs.push('--read-only');

    // network
    if (container.network) {
      runArgs.push('--network', String(container.network));
    } else {
      // default to none for stricter security if explicitly requested by env
      if (env.CONTAINER_NETWORK === 'none') runArgs.push('--network', 'none');
    }

    // resources
    const resources = container.resources || {};
    if (resources.cpus != null) runArgs.push('--cpus', String(resources.cpus));
    if (resources.memory) runArgs.push('--memory', String(resources.memory));

    // workdir
    if (container.workdir) runArgs.push('-w', String(container.workdir));

    // volumes
    const volumes = Array.isArray(container.volumes) ? container.volumes : [];
    for (const v of volumes) {
      if (!v || !v.hostPath || !v.containerPath) continue;
      const ro = v.readOnly ? ':ro' : '';
      // Note: quoting paths with spaces can be shell-specific; rely on spawn(shell=true on win) in StdioAdapter
      runArgs.push('-v', `${v.hostPath}:${v.containerPath}${ro}`);
    }

    // env passthrough
    const passEnv: Record<string, string> = { ...env };
    // Remove SANDBOX hints from child env inside container
    delete passEnv.SANDBOX;
    delete passEnv.SANDBOX_NODE_DIR;
    delete passEnv.SANDBOX_PYTHON_DIR;
    delete passEnv.SANDBOX_GO_DIR;

    for (const [k, v] of Object.entries(passEnv)) {
      // Only pass simple strings
      if (typeof v === 'string') runArgs.push('-e', `${k}=${v}`);
    }

    // Image
    runArgs.push(image);

    // Command inside container
    if (!innerCmd) {
      throw new Error('Command is required to run inside container (config.command)');
    }
    runArgs.push(innerCmd);
    for (const a of innerArgs) {
      runArgs.push(String(a));
    }

    const innerConfig: McpServiceConfig = {
      ...config,
      // Replace command to invoke container runtime
      command: runtime,
      args: runArgs,
      // Ensure we do NOT apply portable sandbox env mutation inside Stdio adapter
      env: { ...passEnv }
    };

    this.logger.info(`Creating container adapter for ${config.name}`, { runtime, image });
    this.delegate = new StdioTransportAdapter(innerConfig, this.logger);

    // Bubble up delegate events
    this.delegate.on('message', (m) => this.emit('message', m));
    this.delegate.on('sent', (m) => this.emit('sent', m));
    this.delegate.on('stderr', (l) => this.emit('stderr', l as any));
    this.delegate.on('disconnect', (e) => this.emit('disconnect', e));
    this.delegate.on('error', (e) => this.emit('error', e as any));
  }

  async connect(): Promise<void> {
    try {
      await this.delegate.connect();
      this.logger.info(`Container adapter connected for ${this.config.name}`);
    } catch (e) {
      // Fallback: if docker fails and runtime unspecified, try podman once
      const container = (this.config as any).container || {};
      const runtime: string = container.runtime || process.env.CONTAINER_RUNTIME || 'docker';
      if (runtime === 'docker') {
        try {
          this.logger.warn('Docker failed to start; retry with podman');
          (this.config as any).container = { ...container, runtime: 'podman' };
          const retry = new ContainerTransportAdapter(this.config, this.logger);
          this.delegate = (retry as any).delegate;
          await this.delegate.connect();
          return;
        } catch (err) {
          this.logger.error('Podman fallback failed', err as any);
        }
      }
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this.delegate.disconnect();
  }

  async send(message: McpMessage): Promise<void> {
    await this.delegate.send(message);
  }

  async receive(): Promise<McpMessage> {
    return this.delegate.receive();
  }

  isConnected(): boolean {
    return this.delegate.isConnected();
  }
}
