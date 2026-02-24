import {
  ProtocolAdapters,
  TransportAdapter,
  McpServiceConfig,
  McpMessage,
  TransportType,
  Logger,
  GatewayConfig
} from '../types/index.js';
import { StdioTransportAdapter } from './StdioTransportAdapter.js';
import { HttpTransportAdapter } from './HttpTransportAdapter.js';
import { StreamableHttpAdapter } from './StreamableHttpAdapter.js';
import { ContainerTransportAdapter } from './ContainerTransportAdapter.js';
import { AdapterPool } from './AdapterPool.js';
import { AdapterRegistry } from './AdapterRegistry.js';
import { mcpRequest } from '../core/mcpMessage.js';
import { applyGatewaySandboxPolicy } from '../security/SandboxPolicy.js';
import { resolveMcpServiceConfigEnvRefs } from '../security/secrets.js';
import { validateNotPrivateUrl } from './ssrf-guard.js';

export class ProtocolAdaptersImpl implements ProtocolAdapters {
  private readonly registry: AdapterRegistry;

  constructor(
    private logger: Logger,
    private getGatewayConfig?: () => GatewayConfig,
    private adapterPool?: AdapterPool,
    registry?: AdapterRegistry
  ) {
    this.registry = registry ?? new AdapterRegistry();
    this.registerDefaultFactories();
  }

  private prepareConfig(config: McpServiceConfig): { enforced: ReturnType<typeof applyGatewaySandboxPolicy>; effective: McpServiceConfig } {
    const gwConfig = this.getGatewayConfig?.();
    const enforced = applyGatewaySandboxPolicy(config, gwConfig);
    const effective = resolveMcpServiceConfigEnvRefs(enforced.config);
    if (enforced.applied) {
      try {
        this.logger.warn?.('Sandbox policy enforced for service', { name: config.name, reasons: enforced.reasons });
      } catch { /* best-effort: sandbox policy log */ }
    }
    return { enforced, effective };
  }

  private async createAdapterInternal(config: McpServiceConfig, enforced: ReturnType<typeof applyGatewaySandboxPolicy>): Promise<TransportAdapter> {
    return this.registry.create(config.transport, { config, enforced, logger: this.logger });
  }

  private registerDefaultFactories(): void {
    this.safeRegister('stdio', ({ config, enforced, logger }) => {
      // Detect container sandbox
      if ((config as Record<string, unknown>)?.container || config.env?.SANDBOX === 'container') {
        logger.info(`Creating container-stdio adapter for ${config.name} [SANDBOX: container]`);
        // Pass global sandbox policy hints to adapter for env/volume validation defaults
        const sandbox = enforced.policy.container;
        return new ContainerTransportAdapter(config, logger, {
          allowedVolumeRoots: sandbox.allowedVolumeRoots,
          envSafePrefixes: sandbox.envSafePrefixes,
          defaultNetwork: sandbox.defaultNetwork,
          defaultReadonlyRootfs: sandbox.defaultReadonlyRootfs,
          defaultPidsLimit: sandbox.defaultPidsLimit,
          defaultNoNewPrivileges: sandbox.defaultNoNewPrivileges,
          defaultDropCapabilities: sandbox.defaultDropCapabilities
        });
      }

      const sandboxed = config.env?.SANDBOX === 'portable';
      logger.info(`Creating stdio adapter for ${config.name}${sandboxed ? ' [SANDBOX: portable]' : ''}`);
      return new StdioTransportAdapter(config, logger);
    });

    this.safeRegister('http', ({ config, logger }) => {
      logger.debug(`Creating HTTP adapter for ${config.name}`);
      return new HttpTransportAdapter(config, logger);
    });

    this.safeRegister('streamable-http', ({ config, logger }) => {
      logger.debug(`Creating Streamable HTTP adapter for ${config.name}`);
      return new StreamableHttpAdapter(config, logger);
    });
  }

  private safeRegister(type: 'stdio' | 'http' | 'streamable-http', factory: Parameters<AdapterRegistry['register']>[1]): void {
    try {
      this.registry.register(type, factory);
    } catch (error) {
      const message = (error as Error)?.message || '';
      if (!message.includes('already registered')) throw error;
    }
  }

  async createHttpAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    const prepared = this.prepareConfig(config);
    if (prepared.effective.transport !== 'http') {
      throw new Error(`createHttpAdapter expected transport=http, got ${prepared.effective.transport}`);
    }
    return this.createAdapterInternal(prepared.effective, prepared.enforced);
  }

  async createStreamableAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    const prepared = this.prepareConfig(config);
    if (prepared.effective.transport !== 'streamable-http') {
      throw new Error(`createStreamableAdapter expected transport=streamable-http, got ${prepared.effective.transport}`);
    }
    return this.createAdapterInternal(prepared.effective, prepared.enforced);
  }

  async createStdioAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    const prepared = this.prepareConfig(config);
    if (prepared.effective.transport !== 'stdio') {
      throw new Error(`createStdioAdapter expected transport=stdio, got ${prepared.effective.transport}`);
    }
    return this.createAdapterInternal(prepared.effective, prepared.enforced);
  }

  async detectProtocol(endpoint: string): Promise<TransportType> {
    // Protocol detection logic
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      // Check if it's streamable HTTP by probing for SSE support
      if (await this.isStreamableHttp(endpoint)) {
        return 'streamable-http';
      }
      return 'http';
    }

    // Default to stdio for command-based configurations
    return 'stdio';
  }

  async validateProtocol(adapter: TransportAdapter, version: string): Promise<boolean> {
    try {
      await adapter.connect();

      const testMessage = mcpRequest('initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: {
            name: 'MCP-Nexus-test',
            version: '1.0.0'
          }
        }, 'protocol-test');

      await adapter.send(testMessage);
      let timeoutId: ReturnType<typeof setTimeout>;
      let response: unknown;
      try {
        response = await Promise.race([
          adapter.receive(),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Protocol validation timeout')), 5000);
          })
        ]);
      } finally {
        clearTimeout(timeoutId!);
      }

      return this.isValidMcpResponse(response);
    } catch (error) {
      this.logger.warn(`Protocol validation failed:`, error);
      return false;
    } finally {
      try { await adapter.disconnect(); } catch { /* best-effort */ }
    }
  }

  private async isStreamableHttp(endpoint: string): Promise<boolean> {
    validateNotPrivateUrl(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      });

      const contentType = response.headers.get('content-type');
      return contentType?.includes('text/event-stream') || false;
    } catch (error) {
      this.logger?.warn?.('SSE endpoint check failed', { error: (error as Error)?.message });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private isValidMcpResponse(response: unknown): response is Record<string, unknown> {
    return (
      !!response &&
      typeof response === 'object' &&
      (response as Record<string, unknown>).jsonrpc === '2.0' &&
      ((response as Record<string, unknown>).result !== undefined || (response as Record<string, unknown>).error !== undefined)
    );
  }

  // Factory method to create appropriate adapter based on config
  async createAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    if (this.adapterPool) {
      const cached = this.adapterPool.get(config.name);
      if (cached) {
        this.logger.debug(`Reusing pooled adapter for ${config.name}`);
        return cached;
      }
    }

    const prepared = this.prepareConfig(config);
    return this.createAdapterInternal(prepared.effective, prepared.enforced);
  }

  releaseAdapter(config: McpServiceConfig, adapter: TransportAdapter): void {
    if (this.adapterPool) {
      this.adapterPool.release(config.name, adapter);
    } else {
      adapter.disconnect().catch(() => { /* best-effort */ });
    }
  }

  async withAdapter<T>(config: McpServiceConfig, fn: (adapter: TransportAdapter) => Promise<T>): Promise<T> {
    const adapter = await this.createAdapter(config);
    if (!adapter.isConnected()) {
      await adapter.connect();
    }
    try {
      return await fn(adapter);
    } finally {
      this.releaseAdapter(config, adapter);
    }
  }
}

/**
 * Normalized send-and-receive: uses adapter.sendAndReceive if available,
 * otherwise falls back to send() + receive().
 */
export async function sendRequest(adapter: TransportAdapter, message: McpMessage): Promise<unknown> {
  if (typeof adapter.sendAndReceive === 'function') {
    return adapter.sendAndReceive(message);
  }
  await adapter.send(message);
  return adapter.receive();
}
