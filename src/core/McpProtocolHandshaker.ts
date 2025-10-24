import { McpVersion, McpMessage, McpProtocolStack, Logger, MCP_VERSIONS } from '../types/index.js';

export class McpProtocolHandshaker {
  constructor(private logger: Logger) {}

  async negotiateVersion(serviceId: string, supportedVersions: McpVersion[]): Promise<McpVersion> {
    // Sort versions by preference (latest first)
    const sortedVersions = [...supportedVersions].sort((a, b) => b.localeCompare(a));
    
    // For now, return the latest supported version
    // In a real implementation, this would involve protocol negotiation with the service
    const selectedVersion = sortedVersions[0];
    
    this.logger.debug(`Version negotiated for ${serviceId}: ${selectedVersion}`);
    return selectedVersion;
  }

  async performHandshake(serviceId: string, protocolStack: McpProtocolStack): Promise<void> {
    try {
      // Determine protocol version via negotiation (prefer latest)
      const negotiatedVersion = await this.negotiateVersion(serviceId, [...MCP_VERSIONS]);

      // Step 1: Send initialize message
      const initMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: negotiatedVersion,
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
            resources: { subscribe: true, listChanged: true },
            tools: { listChanged: true },
            prompts: { listChanged: true }
          },
          clientInfo: {
            name: 'pb-mcpgateway',
            version: '1.0.0'
          }
        }
      };

      const initResponse = await protocolStack.sendMessage(serviceId, initMessage);
      
      if (initResponse.error) {
        throw new Error(`Initialize failed: ${initResponse.error.message}`);
      }

      // Step 2: Send initialized notifications (兼容不同实现)
      const initializedMessage1: McpMessage = {
        jsonrpc: '2.0',
        method: 'initialized'
      };
      const initializedMessage2: McpMessage = {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      };

      // Fire-and-forget both variants to maximize compatibility
      await protocolStack.sendMessage(serviceId, initializedMessage1);
      await protocolStack.sendMessage(serviceId, initializedMessage2);

      // Step 3: Verify the service is ready
      await this.verifyServiceReady(serviceId, protocolStack);

      this.logger.info(`Handshake completed successfully for ${serviceId}`);
    } catch (error) {
      this.logger.error(`Handshake failed for ${serviceId}:`, error);
      throw error;
    }
  }

  private async verifyServiceReady(serviceId: string, protocolStack: McpProtocolStack): Promise<void> {
    try {
      // Send a ping or list_tools request to verify the service is responsive
      const pingMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `ping-${Date.now()}`,
        method: 'tools/list'
      };

      const response = await protocolStack.sendMessage(serviceId, pingMessage);
      
      if (response.error && response.error.code !== -32601) { // Method not found is acceptable
        throw new Error(`Service verification failed: ${response.error.message}`);
      }

      this.logger.debug(`Service ${serviceId} verified as ready`);
    } catch (error) {
      // Non-critical error - service might still be functional
      this.logger.warn(`Service verification warning for ${serviceId}:`, error);
    }
  }

  async getServerCapabilities(serviceId: string, protocolStack: McpProtocolStack): Promise<any> {
    const negotiatedVersion = await this.negotiateVersion(serviceId, [...MCP_VERSIONS]);
    const message: McpMessage = {
      jsonrpc: '2.0',
      id: `caps-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion: negotiatedVersion,
        capabilities: {},
        clientInfo: {
          name: 'pb-mcpgateway',
          version: '1.0.0'
        }
      }
    };

    const response = await protocolStack.sendMessage(serviceId, message);
    
    if (response.error) {
      throw new Error(`Failed to get server capabilities: ${response.error.message}`);
    }

    return response.result?.capabilities || {};
  }
}
