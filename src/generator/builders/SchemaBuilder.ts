import type { ParseResult, McpToolSchema, Logger } from '../../types/index.js';

/**
 * Schema Builder
 * Converts ParseResult to MCP Tool Schema
 */
export class SchemaBuilder {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Build MCP Tool Schema from ParseResult
   */
  build(parseResult: ParseResult, toolName?: string): McpToolSchema {
    const name = toolName || this.generateToolName(parseResult);
    const description = parseResult.intent || 'Auto-generated tool';

    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const param of parseResult.parameters) {
      properties[param.name] = {
        type: param.type,
        description: param.description || `Parameter: ${param.name}`
      };

      if (param.default !== undefined) {
        properties[param.name].default = param.default;
      }

      if (param.enum) {
        properties[param.name].enum = param.enum;
      }

      if (param.type === 'array') {
        properties[param.name].items = { type: 'string' }; // Default item type
      }

      if (param.required) {
        required.push(param.name);
      }
    }

    const inputSchema = {
      type: 'object' as const,
      properties,
      ...(required.length > 0 && { required })
    };

    this.logger.debug(`Built MCP tool schema: ${name}`, { properties: Object.keys(properties) });

    return {
      name,
      description,
      inputSchema
    };
  }

  /**
   * Generate tool name from ParseResult
   */
  private generateToolName(parseResult: ParseResult): string {
    const { intent, endpoint } = parseResult;

    // Try to extract meaningful name from intent
    if (intent) {
      const words = intent.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2);

      if (words.length > 0) {
        return words.slice(0, 3).join('_');
      }
    }

    // Fallback: use endpoint path
    const path = endpoint.url.split('/').filter(Boolean).pop() || 'api';
    const method = endpoint.method.toLowerCase();

    return `${method}_${path}`;
  }

  /**
   * Build multiple tool schemas for complex APIs
   */
  buildMultiple(parseResults: ParseResult[]): McpToolSchema[] {
    return parseResults.map(result => this.build(result));
  }
}
