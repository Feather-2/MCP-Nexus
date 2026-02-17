import {
  ProtocolAdapters,
  TransportAdapter,
  McpServiceConfig,
  TransportType,
  Logger,
  GatewayConfig
} from '../types/index.js';
import { StdioTransportAdapter } from './StdioTransportAdapter.js';
import { HttpTransportAdapter } from './HttpTransportAdapter.js';
import { StreamableHttpAdapter } from './StreamableHttpAdapter.js';
import { ContainerTransportAdapter } from './ContainerTransportAdapter.js';
import { AdapterPool } from './AdapterPool.js';
import { applyGatewaySandboxPolicy } from '../security/SandboxPolicy.js';
import { resolveMcpServiceConfigEnvRefs } from '../security/secrets.js';

export class ProtocolAdaptersImpl implements ProtocolAdapters {
  constructor(
    private logger: Logger,
    private getGatewayConfig?: () => GatewayConfig,
    private adapterPool?: AdapterPool
  ) {}

  private prepareConfig(config: McpServiceConfig): { enforced: ReturnType<typeof applyGatewaySandboxPolicy>; effective: McpServiceConfig } {
    const gwConfig = this.getGatewayConfig?.();
    const enforced = applyGatewaySandboxPolicy(config, gwConfig);
    const effective = resolveMcpServiceConfigEnvRefs(enforced.config);
    if (enforced.applied) {
      try {
        this.logger.warn?.('Sandbox policy enforced for service', { name: config.name, reasons: enforced.reasons });
      } catch (_e) { /* sandbox policy log failed */ }
    }
    return { enforced, effective };
  }

  private async createAdapterInternal(config: McpServiceConfig, enforced: ReturnType<typeof applyGatewaySandboxPolicy>): Promise<TransportAdapter> {
    switch (config.transport) {
      case 'stdio': {
        // Detect container sandbox
        if ((config as Record<string, unknown>)?.container || config.env?.SANDBOX === 'container') {
          this.logger.info(`Creating container-stdio adapter for ${config.name} [SANDBOX: container]`);
          // Pass global sandbox policy hints to adapter for env/volume validation defaults
          const sandbox = enforced.policy.container;
          return new ContainerTransportAdapter(config, this.logger, {
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
        this.logger.info(`Creating stdio adapter for ${config.name}${sandboxed ? ' [SANDBOX: portable]' : ''}`);
        return new StdioTransportAdapter(config, this.logger);
      }
      case 'http':
        this.logger.debug(`Creating HTTP adapter for ${config.name}`);
        return new HttpTransportAdapter(config, this.logger);
      case 'streamable-http':
        this.logger.debug(`Creating Streamable HTTP adapter for ${config.name}`);
        return new StreamableHttpAdapter(config, this.logger);
      default:
        throw new Error(`Unsupported transport type: ${config.transport}`);
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

      const testMessage = {
        jsonrpc: '2.0' as const,
        id: 'protocol-test',
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: {
            name: 'MCP-Nexus-test',
            version: '1.0.0'
          }
        }
      };

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
      try { await adapter.disconnect(); } catch {}
    }
  }

  private async isStreamableHttp(endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });

      const contentType = response.headers.get('content-type');
      return contentType?.includes('text/event-stream') || false;
    } catch (e) {
      this.logger?.warn?.('SSE endpoint check failed', { error: (e as Error).message });
      return false;
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
    }
  }
}
