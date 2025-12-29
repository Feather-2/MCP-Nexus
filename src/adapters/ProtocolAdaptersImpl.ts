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
import { applyGatewaySandboxPolicy } from '../security/SandboxPolicy.js';

export class ProtocolAdaptersImpl implements ProtocolAdapters {
  constructor(private logger: Logger, private getGatewayConfig?: () => GatewayConfig) {}

  async createStdioAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    const sandboxed = (config.env as any)?.SANDBOX === 'portable';
    this.logger.info(`Creating stdio adapter for ${config.name}${sandboxed ? ' [SANDBOX: portable]' : ''}`);
    return new StdioTransportAdapter(config, this.logger);
  }

  async createHttpAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    this.logger.debug(`Creating HTTP adapter for ${config.name}`);
    return new HttpTransportAdapter(config, this.logger);
  }

  async createStreamableAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    this.logger.debug(`Creating Streamable HTTP adapter for ${config.name}`);
    return new StreamableHttpAdapter(config, this.logger);
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

      // Send a test message to validate protocol compatibility
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
      const response = await Promise.race([
        adapter.receive(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Protocol validation timeout')), 5000)
        )
      ]);

      await adapter.disconnect();

      // Check if response is valid MCP format
      return this.isValidMcpResponse(response);
    } catch (error) {
      this.logger.warn(`Protocol validation failed:`, error);
      return false;
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
    } catch {
      return false;
    }
  }

  private isValidMcpResponse(response: any): boolean {
    return (
      response &&
      typeof response === 'object' &&
      response.jsonrpc === '2.0' &&
      (response.result !== undefined || response.error !== undefined)
    );
  }

  // Factory method to create appropriate adapter based on config
  async createAdapter(config: McpServiceConfig): Promise<TransportAdapter> {
    const gwConfig = this.getGatewayConfig?.();
    const enforced = applyGatewaySandboxPolicy(config, gwConfig);
    const effectiveConfig = enforced.config;
    if (enforced.applied) {
      try {
        this.logger.warn?.('Sandbox policy enforced for service', { name: config.name, reasons: enforced.reasons });
      } catch { /* ignored */ }
    }

    switch (effectiveConfig.transport) {
      case 'stdio':
        // Detect container sandbox
        if ((effectiveConfig as any)?.container || (effectiveConfig.env as any)?.SANDBOX === 'container') {
          this.logger.info(`Creating container-stdio adapter for ${effectiveConfig.name} [SANDBOX: container]`);
          // Pass global sandbox policy hints to adapter for env/volume validation defaults
          const sandbox = enforced.policy.container;
          return new ContainerTransportAdapter(effectiveConfig, this.logger, {
            allowedVolumeRoots: sandbox.allowedVolumeRoots,
            envSafePrefixes: sandbox.envSafePrefixes,
            defaultNetwork: sandbox.defaultNetwork,
            defaultReadonlyRootfs: sandbox.defaultReadonlyRootfs
          });
        }
        return this.createStdioAdapter(effectiveConfig);
      case 'http':
        return this.createHttpAdapter(effectiveConfig);
      case 'streamable-http':
        return this.createStreamableAdapter(effectiveConfig);
      default:
        throw new Error(`Unsupported transport type: ${effectiveConfig.transport}`);
    }
  }
}
