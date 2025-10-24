import {
  ProtocolAdapters,
  TransportAdapter,
  McpServiceConfig,
  TransportType,
  Logger
} from '../types/index.js';
import { StdioTransportAdapter } from './StdioTransportAdapter.js';
import { HttpTransportAdapter } from './HttpTransportAdapter.js';
import { StreamableHttpAdapter } from './StreamableHttpAdapter.js';

export class ProtocolAdaptersImpl implements ProtocolAdapters {
  constructor(private logger: Logger) {}

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
            name: 'pb-mcpgateway-test',
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
    switch (config.transport) {
      case 'stdio':
        return this.createStdioAdapter(config);
      case 'http':
        return this.createHttpAdapter(config);
      case 'streamable-http':
        return this.createStreamableAdapter(config);
      default:
        throw new Error(`Unsupported transport type: ${config.transport}`);
    }
  }
}