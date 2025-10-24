import { TransportAdapter, McpServiceConfig, McpMessage, Logger, McpVersion } from '../types/index.js';
import { EventEmitter } from 'events';

export class StreamableHttpAdapter extends EventEmitter implements TransportAdapter {
  readonly type = 'streamable-http' as const;
  readonly version: McpVersion;
  
  private baseUrl: string;
  private connected = false;
  private headers: Record<string, string>;
  private eventSource: EventSource | null = null;
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
    
    // Extract URL from config
    this.baseUrl = this.extractUrlFromConfig(config);
    
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(config.env?.HTTP_HEADERS ? JSON.parse(config.env.HTTP_HEADERS) : {})
    };

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
      // Create EventSource for receiving server-sent events
      const sseUrl = this.baseUrl.replace('/http', '/sse') || `${this.baseUrl}/events`;
      
      this.eventSource = new EventSource(sseUrl, {
        withCredentials: false
      });

      // Set up EventSource handlers
      this.setupEventSourceHandlers();

      // Wait for connection to be established
      await new Promise<void>((resolve, reject) => {
        const connectionTimeout = this.config.timeout || 10000;
        const timeout = setTimeout(() => {
          reject(new Error('StreamableHttp connection timeout'));
        }, connectionTimeout);

        const onOpen = () => {
          clearTimeout(timeout);
          this.eventSource!.removeEventListener('open', onOpen);
          this.eventSource!.removeEventListener('error', onError);
          resolve();
        };

        const onError = (error: Event) => {
          clearTimeout(timeout);
          this.eventSource!.removeEventListener('open', onOpen);
          this.eventSource!.removeEventListener('error', onError);
          reject(new Error(`StreamableHttp connection failed: ${error}`));
        };

        this.eventSource!.addEventListener('open', onOpen);
        this.eventSource!.addEventListener('error', onError);
      });

      this.connected = true;
      this.logger.info(`StreamableHttp adapter connected to ${this.baseUrl}`);
    } catch (error) {
      this.logger.error(`Failed to connect StreamableHttp adapter:`, error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      // Clear all pending callbacks
      for (const [id, callback] of this.responseCallbacks) {
        clearTimeout(callback.timeout);
        callback.reject(new Error('Connection closed'));
      }
      this.responseCallbacks.clear();

      // Close EventSource
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }

      this.connected = false;
      this.logger.info(`StreamableHttp adapter disconnected from ${this.baseUrl}`);
    } catch (error) {
      this.logger.error(`Error disconnecting StreamableHttp adapter:`, error);
      throw error;
    }
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
        throw new Error(`StreamableHttp request failed: ${response.status} ${response.statusText}`);
      }

      this.logger.trace(`Sent StreamableHttp message:`, message);
    } catch (error) {
      this.logger.error(`Failed to send StreamableHttp message:`, error);
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

    // Wait for next message from SSE stream
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
    return this.connected && this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }

  // Send a message and wait for response with matching ID (for request-response pattern)
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

  private setupEventSourceHandlers(): void {
    if (!this.eventSource) return;

    this.eventSource.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as McpMessage;
        this.handleMessage(message);
      } catch (error) {
        this.logger.warn(`Failed to parse SSE message:`, { data: event.data, error });
      }
    };

    this.eventSource.onerror = (error) => {
      this.logger.error(`StreamableHttp SSE error:`, error);
      
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        this.connected = false;
        this.emit('disconnect', error);
      } else {
        this.emit('error', error);
      }
    };

    // Handle custom event types if needed
    this.eventSource.addEventListener('mcp-message', (event) => {
      try {
        const customEvent = event as MessageEvent;
        const message = JSON.parse(customEvent.data) as McpMessage;
        this.handleMessage(message);
      } catch (error) {
        this.logger.warn(`Failed to parse custom SSE message:`, { data: event, error });
      }
    });
  }

  private handleMessage(message: McpMessage): void {
    this.logger.trace(`Received message via StreamableHttp:`, message);

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

  private extractUrlFromConfig(config: McpServiceConfig): string {
    // Try to extract URL from various possible config locations
    
    // Check if there's a direct url in env
    if (config.env?.MCP_SERVER_URL) {
      return config.env.MCP_SERVER_URL;
    }
    
    // Check if the command itself is a URL
    if (config.command?.startsWith('http')) {
      return config.command;
    }
    
    // Try to construct from host and port in env
    if (config.env?.MCP_HOST && config.env?.MCP_PORT) {
      const protocol = config.env.MCP_HTTPS === 'true' ? 'https' : 'http';
      return `${protocol}://${config.env.MCP_HOST}:${config.env.MCP_PORT}`;
    }
    
    // Default fallback
    return config.env?.MCP_BASE_URL || 'http://localhost:3000';
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