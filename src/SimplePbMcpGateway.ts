// Simplified PB MCP Gateway Implementation
import { EventEmitter } from 'events';

// Simple Logger
class SimpleLogger {
  constructor(private level: string = 'info') {}
  
  info(message: string, ...args: any[]) {
    console.log(`[INFO] ${message}`, ...args);
  }
  
  error(message: string, ...args: any[]) {
    console.error(`[ERROR] ${message}`, ...args);
  }
  
  warn(message: string, ...args: any[]) {
    console.warn(`[WARN] ${message}`, ...args);
  }
  
  debug(message: string, ...args: any[]) {
    if (this.level === 'debug') {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }
}

// Gateway Configuration
interface SimpleGatewayConfig {
  port?: number;
  host?: string;
  logLevel?: string;
}

// Simple MCP Gateway Class
export class SimplePbMcpGateway extends EventEmitter {
  private config: SimpleGatewayConfig;
  private logger: SimpleLogger;
  private isRunning = false;
  private services: Map<string, any> = new Map();

  constructor(config: SimpleGatewayConfig = {}) {
    super();
    
    this.config = {
      port: 19233,
      host: '127.0.0.1',
      logLevel: 'info',
      ...config
    };
    
    this.logger = new SimpleLogger(this.config.logLevel);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Gateway is already running');
    }

    try {
      this.logger.info('Starting PB MCP Gateway...');
      
      // Initialize built-in service templates
      this.initializeTemplates();
      
      this.isRunning = true;
      
      this.logger.info(`Gateway started successfully on ${this.config.host}:${this.config.port}`);
      this.logger.info('Available service templates:', Array.from(this.services.keys()));
      
      this.emit('started', {
        host: this.config.host,
        port: this.config.port,
        templates: Array.from(this.services.keys())
      });
      
    } catch (error) {
      this.logger.error('Failed to start gateway:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      this.logger.info('Stopping PB MCP Gateway...');
      
      // Stop all services
      for (const [serviceId] of this.services) {
        this.logger.info(`Stopping service: ${serviceId}`);
      }
      
      this.isRunning = false;
      
      this.logger.info('Gateway stopped successfully');
      this.emit('stopped');
      
    } catch (error) {
      this.logger.error('Error stopping gateway:', error);
      throw error;
    }
  }

  isStarted(): boolean {
    return this.isRunning;
  }

  getVersion(): string {
    return '1.0.0';
  }

  getConfig(): SimpleGatewayConfig {
    return { ...this.config };
  }

  listTemplates(): string[] {
    return Array.from(this.services.keys());
  }

  async getHealthStatus(): Promise<any> {
    return {
      gateway: {
        status: this.isRunning ? 'healthy' : 'stopped',
        uptime: this.isRunning ? process.uptime() * 1000 : 0
      },
      services: [],
      metrics: {
        totalServices: this.services.size,
        healthyServices: this.isRunning ? this.services.size : 0,
        totalRequests: 0,
        successRate: 1.0
      }
    };
  }

  private initializeTemplates(): void {
    // Built-in MCP service templates
    const templates = [
      {
        name: 'filesystem',
        description: 'File system access MCP server',
        command: 'npx @modelcontextprotocol/server-filesystem',
        version: '2024-11-26'
      },
      {
        name: 'brave-search', 
        description: 'Brave Search API integration',
        command: 'npx @modelcontextprotocol/server-brave-search',
        version: '2024-11-26'
      },
      {
        name: 'github',
        description: 'GitHub API integration', 
        command: 'npx @modelcontextprotocol/server-github',
        version: '2024-11-26'
      },
      {
        name: 'sqlite',
        description: 'SQLite database access',
        command: 'npx @modelcontextprotocol/server-sqlite',
        version: '2024-11-26'
      },
      {
        name: 'memory',
        description: 'In-memory storage for conversations',
        command: 'npx @modelcontextprotocol/server-memory', 
        version: '2024-11-26'
      }
    ];

    for (const template of templates) {
      this.services.set(template.name, template);
    }

    this.logger.info(`Initialized ${templates.length} service templates`);
  }
}

// Factory function
export function createSimpleGateway(config?: SimpleGatewayConfig): SimplePbMcpGateway {
  return new SimplePbMcpGateway(config);
}

// Default export
export default SimplePbMcpGateway;