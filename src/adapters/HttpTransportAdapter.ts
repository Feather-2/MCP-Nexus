import { TransportAdapter, McpServiceConfig, McpMessage, Logger, McpVersion } from '../types/index.js';
import { EventEmitter } from 'events';

export class HttpTransportAdapter extends EventEmitter implements TransportAdapter {
  readonly type = 'http' as const;
  readonly version: McpVersion;
  
  private baseUrl: string;
  private connected = false;
  private headers: Record<string, string>;

  constructor(
    private config: McpServiceConfig,
    private logger: Logger
  ) {
    super();
    this.version = config.version;
    
    // Extract URL from config - could be in command or a separate url field
    this.baseUrl = this.extractUrlFromConfig(config);
    
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    // Safely merge extra headers from env
    try {
      if (config.env?.HTTP_HEADERS) {
        const parsed = JSON.parse(config.env.HTTP_HEADERS);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && typeof v === 'string') this.headers[k] = v;
          }
        } else {
          this.logger.warn('Invalid HTTP_HEADERS format (must be object)');
        }
      }
    } catch (e) {
      this.logger.warn('Invalid HTTP_HEADERS JSON', { error: (e as Error)?.message });
    }

    // Add authentication headers if provided
    if (config.env?.API_KEY) {
      this.headers['Authorization'] = `Bearer ${config.env.API_KEY}`;
    }
    if (config.env?.API_TOKEN) {
      this.headers['X-API-Token'] = config.env.API_TOKEN;
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      // Test connection with a simple HTTP request
      const testResponse = await fetch(this.baseUrl, {
        method: 'OPTIONS',
        headers: this.headers
      });

      if (!testResponse.ok && testResponse.status !== 404) {
        // 404 is acceptable for OPTIONS requests
        throw new Error(`HTTP connection failed: ${testResponse.status} ${testResponse.statusText}`);
      }

      this.connected = true;
      this.logger.info(`HTTP adapter connected to ${this.baseUrl}`);
    } catch (error) {
      this.logger.error(`Failed to connect HTTP adapter:`, error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.logger.info(`HTTP adapter disconnected from ${this.baseUrl}`);
  }

  async send(message: McpMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('Adapter not connected');
    }

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        throw new Error(`HTTP request failed: ${response.status} ${response.statusText}`);
      }

      this.logger.trace(`Sent HTTP message:`, message);
    } catch (error) {
      this.logger.error(`Failed to send HTTP message:`, error);
      throw error;
    }
  }

  async receive(): Promise<McpMessage> {
    if (!this.connected) {
      throw new Error('Adapter not connected');
    }

    // For HTTP, we don't typically "receive" unsolicited messages
    // This would be used in a polling scenario or with webhooks
    throw new Error('HTTP adapter does not support unsolicited message receiving. Use sendAndReceive instead.');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // HTTP-specific method for request-response pattern
  async sendAndReceive(message: McpMessage): Promise<McpMessage> {
    if (!this.connected) {
      throw new Error('Adapter not connected');
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 30000);

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP request failed: ${response.status} ${response.statusText}`);
      }

      const responseData = await response.json() as McpMessage;
      
      this.logger.trace(`HTTP request-response completed:`, { request: message, response: responseData });
      
      return responseData;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`HTTP request timeout for message ${message.id}`);
      }
      this.logger.error(`HTTP request failed:`, error);
      throw error;
    }
  }

  private extractUrlFromConfig(config: McpServiceConfig): string {
    // Try to extract URL from various possible config locations
    
    // Check if there's a direct url in env
    if (config.env?.MCP_SERVER_URL) {
      return config.env.MCP_SERVER_URL;
    }
    
    // Check if the command itself is a URL
    if (config.command?.startsWith('http')) {
      if (this.isValidUrl(config.command)) return config.command;
    }
    
    // Try to construct from host and port in env
    if (config.env?.MCP_HOST && config.env?.MCP_PORT) {
      const protocol = config.env.MCP_HTTPS === 'true' ? 'https' : 'http';
      return `${protocol}://${config.env.MCP_HOST}:${config.env.MCP_PORT}`;
    }
    
    // Default fallback
    const fallback = config.env?.MCP_BASE_URL || 'http://localhost:3000';
    return this.isValidUrl(fallback) ? fallback : 'http://localhost:3000';
  }

  private isValidUrl(urlStr: string): boolean {
    try {
      const u = new URL(urlStr);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // Utility method for health checks
  async healthCheck(): Promise<boolean> {
    try {
      const healthMessage: McpMessage = {
        jsonrpc: '2.0',
        id: 'health-check',
        method: 'tools/list'
      };

      const response = await this.sendAndReceive(healthMessage);
      return !response.error;
    } catch {
      return false;
    }
  }
}