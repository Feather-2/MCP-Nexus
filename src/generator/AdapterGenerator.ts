import type { ParseResult, McpServiceConfig, McpToolSchema, TransportType, Logger } from '../types/index.js';
import { SchemaBuilder } from './builders/SchemaBuilder.js';

/**
 * Adapter Generator
 * Generates MCP service configuration and adapter code
 */
export class AdapterGenerator {
  private logger: Logger;
  private schemaBuilder: SchemaBuilder;

  constructor(logger: Logger) {
    this.logger = logger;
    this.schemaBuilder = new SchemaBuilder(logger);
  }

  /**
   * Generate MCP service configuration
   */
  async generate(
    parseResult: ParseResult,
    options: {
      name?: string;
      transport?: 'auto' | TransportType;
    } = {}
  ): Promise<{ config: McpServiceConfig; tools: McpToolSchema[] }> {
    const name = options.name || this.generateServiceName(parseResult);
    const transport = options.transport === 'auto'
      ? this.selectTransport(parseResult)
      : (options.transport as TransportType);

    const tools = [this.schemaBuilder.build(parseResult, name)];

    let config: McpServiceConfig;

    if (transport === 'http') {
      config = await this.generateHttpConfig(name, parseResult);
    } else if (transport === 'stdio') {
      config = await this.generateStdioConfig(name, parseResult);
    } else {
      // streamable-http
      config = await this.generateStreamableHttpConfig(name, parseResult);
    }

    this.logger.info(`Generated ${transport} adapter for ${name}`);

    return { config, tools };
  }

  /**
   * Select appropriate transport based on ParseResult
   */
  private selectTransport(parseResult: ParseResult): TransportType {
    const isHttpEndpoint =
      Boolean(parseResult.endpoint?.baseUrl) ||
      parseResult.endpoint.url.startsWith('http://') ||
      parseResult.endpoint.url.startsWith('https://');

    // If it's a simple HTTP API with no state
    if (isHttpEndpoint && !parseResult.hasStatefulLogic && !parseResult.hasLocalProcessing) {
      return 'http';
    }

    // If it supports streaming
    if (parseResult.supportsStreaming) {
      return 'streamable-http';
    }

    // Default to stdio for complex logic
    return 'stdio';
  }

  /**
   * Generate HTTP transport configuration
   */
  private async generateHttpConfig(
    name: string,
    parseResult: ParseResult
  ): Promise<McpServiceConfig> {
    const { endpoint, auth } = parseResult;
    const baseUrl = endpoint.baseUrl || new URL(endpoint.url).origin;

    const config: McpServiceConfig = {
      name,
      version: '2024-11-26',
      transport: 'http',
      env: {
        BASE_URL: baseUrl,
        ...(auth && { AUTH_TYPE: auth.type }),
        ...(auth && auth.key && { AUTH_KEY: auth.key })
      },
      timeout: 30000,
      retries: 3
    };

    // Add auth placeholder for API keys
    if (auth && auth.type === 'apikey') {
      config.env![`${name.toUpperCase()}_API_KEY`] = '${API_KEY}';
    }

    return config;
  }

  /**
   * Generate Stdio transport configuration (wraps Node.js server)
   */
  private async generateStdioConfig(
    name: string,
    parseResult: ParseResult
  ): Promise<McpServiceConfig> {
    // For stdio, we'll need to generate a Node.js wrapper
    // This will be implemented in Phase 2
    const config: McpServiceConfig = {
      name,
      version: '2024-11-26',
      transport: 'stdio',
      command: 'node',
      args: [`./generated/${name}/index.js`],
      env: {
        API_URL: this.buildFullUrl(parseResult)
      },
      timeout: 30000,
      retries: 3
    };

    if (parseResult.auth) {
      config.env![`${name.toUpperCase()}_API_KEY`] = '${API_KEY}';
    }

    this.logger.warn(`Stdio adapter generation not fully implemented yet. Config created but code generation pending.`);

    return config;
  }

  /**
   * Generate Streamable HTTP configuration
   */
  private async generateStreamableHttpConfig(
    name: string,
    parseResult: ParseResult
  ): Promise<McpServiceConfig> {
    const baseUrl = parseResult.endpoint.baseUrl || new URL(parseResult.endpoint.url).origin;

    const config: McpServiceConfig = {
      name,
      version: '2024-11-26',
      transport: 'streamable-http',
      env: {
        BASE_URL: baseUrl
      },
      timeout: 60000, // Longer timeout for streaming
      retries: 2
    };

    if (parseResult.auth) {
      config.env![`${name.toUpperCase()}_API_KEY`] = '${API_KEY}';
    }

    return config;
  }

  /**
   * Generate service name from ParseResult
   */
  private generateServiceName(parseResult: ParseResult): string {
    const { intent, endpoint } = parseResult;

    // Try URL hostname
    try {
      const url = new URL(endpoint.url);
      const hostname = url.hostname.replace(/^(www|api)\./, '');
      const parts = hostname.split('.');
      if (parts.length > 0) {
        return parts[0] + '-api';
      }
    } catch {
      // Not a full URL
    }

    // Fallback: use intent or path
    if (intent) {
      const words = intent.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w: string) => w.length > 2);

      if (words.length > 0) {
        return words[0] + '-api';
      }
    }

    return 'generated-api';
  }

  /**
   * Generate Node.js wrapper code for stdio transport
   */
  async generateWrapperCode(
    name: string,
    parseResult: ParseResult,
    toolSchema: McpToolSchema
  ): Promise<string> {
    // Template for Node.js MCP server
    const escapeForTemplate = (str: string) => str.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const safeUrl = (() => {
      try {
        const full = this.buildFullUrl(parseResult);
        const u = new URL(full);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
      } catch {
        /* ignored */
      }
      return 'http://localhost';
    })();
    const template = `#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({
  name: '${name}',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [${JSON.stringify(toolSchema, null, 2)}]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === '${toolSchema.name}') {
    const url = new URL('${'${'}SAFE_URL{'}'}');

    // Add query parameters
    ${parseResult.parameters.map((p: any) =>
      `if (args.${p.name}) url.searchParams.set('${p.name}', String(args.${p.name}));`
    ).join('\n    ')}

    const response = await fetch(url.toString(), {
      method: '${parseResult.endpoint.method}',
      headers: {
        ${parseResult.auth?.type === 'apikey' && parseResult.auth.key
          ? `'${parseResult.auth.key}': process.env.${name.toUpperCase()}_API_KEY || '',`
          : ''}
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(\`HTTP error! status: \${response.status}\`);
    }

    const data = await response.json();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }]
    };
  }

  throw new Error(\`Unknown tool: \${name}\`);
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('${name} MCP server running on stdio\\n');
`;
    // Inject SAFE_URL separately to avoid template injection
    return template.replace('${'+'SAFE_URL'+'}', escapeForTemplate(safeUrl));
  }

  private buildFullUrl(parseResult: ParseResult): string {
    const raw = parseResult.endpoint.url;
    // Already absolute
    try {
      const u = new URL(raw);
      return u.toString();
    } catch {
      // ignore
    }
    const baseUrl = parseResult.endpoint.baseUrl;
    if (!baseUrl) return raw;
    return new URL(raw, baseUrl).toString();
  }

  /**
   * Generate package.json for stdio wrapper
   */
  generatePackageJson(name: string): string {
    const packageJson = {
      name: `@pb-mcp/${name}`,
      version: '1.0.0',
      type: 'module',
      description: `Auto-generated MCP server for ${name}`,
      bin: {
        [name]: './index.js'
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0',
        'node-fetch': '^3.3.2'
      },
      keywords: ['mcp', 'api', name],
      license: 'MIT'
    };

    return JSON.stringify(packageJson, null, 2);
  }
}
