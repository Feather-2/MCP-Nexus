import { BaseParser } from './BaseParser.js';
import type { ParseResult, Logger } from '../../types/index.js';

/**
 * Markdown Parser
 * Parses Markdown documentation to extract API information
 */
export class MarkdownParser extends BaseParser {
  constructor(logger: Logger) {
    super(logger);
  }

  supports(content: string): boolean {
    // Check for markdown patterns
    const patterns = [
      /^#\s+/m,           // Headers
      /\*\*.*\*\*/,       // Bold
      /\[.*\]\(.*\)/,     // Links
      /^-\s+/m,           // Lists
      /```/,              // Code blocks
    ];
    return patterns.some(p => p.test(content));
  }

  async parse(content: string): Promise<ParseResult> {
    this.logger.debug('Parsing Markdown content');

    const intent = this.extractIntent(content);
    const endpoint = this.extractEndpoint(content);
    const auth = this.extractAuth(content);
    const parameters = this.extractParameters(content);
    const response = this.extractResponse(content);

    return {
      intent,
      endpoint,
      auth,
      parameters,
      response,
      hasStatefulLogic: false,
      hasLocalProcessing: false,
      supportsStreaming: this.detectStreaming(content)
    };
  }

  private extractEndpoint(content: string): ParseResult['endpoint'] {
    // Extract URL patterns
    const urlPatterns = [
      /(?:url|endpoint|base[_\s]?url):\s*(https?:\/\/[^\s\n]+)/i,
      /(?:GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/[^\s\n]+)/i,
      /(https?:\/\/[^\s\n)]+)/i, // Fallback: any URL
    ];

    let url = '';
    for (const pattern of urlPatterns) {
      const match = content.match(pattern);
      if (match) {
        url = match[1] || match[0];
        break;
      }
    }

    if (!url) {
      throw new Error('No API endpoint URL found in Markdown');
    }

    // Validate protocol (http/https only)
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('Unsupported URL protocol');
      }
    } catch {
      throw new Error('Invalid URL in Markdown');
    }

    // Extract HTTP method
    const methodPattern = /(?:method|verb):\s*(GET|POST|PUT|DELETE|PATCH)/i;
    const methodMatch = content.match(methodPattern);
    const method = (methodMatch?.[1]?.toUpperCase() as any) || 'GET';

    const { baseUrl, path } = this.normalizeUrl(url);

    return {
      url: path,
      method,
      baseUrl: baseUrl || undefined
    };
  }

  private extractAuth(content: string): ParseResult['auth'] | undefined {
    // Check for auth mentions
    const authPatterns = [
      /auth(?:entication)?:\s*API\s*Key/i,
      /auth(?:entication)?:\s*Bearer/i,
      /auth(?:entication)?:\s*Basic/i,
      /auth(?:entication)?:\s*OAuth/i,
      /auth(?:entication)?:\s*None/i,
    ];

    let authType: 'apikey' | 'bearer' | 'basic' | 'oauth2' | 'none' = 'none';
    for (const pattern of authPatterns) {
      if (pattern.test(content)) {
        if (/API\s*Key/i.test(content)) authType = 'apikey';
        else if (/Bearer/i.test(content)) authType = 'bearer';
        else if (/Basic/i.test(content)) authType = 'basic';
        else if (/OAuth/i.test(content)) authType = 'oauth2';
        break;
      }
    }

    if (authType === 'none') return undefined;

    // Extract auth key name
    const keyPatterns = [
      /header:\s*([A-Za-z-]+)/i,
      /key:\s*([A-Za-z-]+)/i,
      /(X-[A-Za-z-]+)/,
      /Authorization/i,
    ];

    let key = 'Authorization';
    for (const pattern of keyPatterns) {
      const match = content.match(pattern);
      if (match) {
        key = match[1] || match[0];
        break;
      }
    }

    return {
      type: authType,
      location: 'header',
      key
    };
  }

  private extractParameters(content: string): ParseResult['parameters'] {
    const parameters: ParseResult['parameters'] = [];

    // Pattern: - paramName (type, required/optional): description
    const paramPattern = /^[-*]\s+(\w+)\s*\(([^,)]+)(?:,\s*(required|optional))?\):\s*(.+)$/gmi;
    let match;

    while ((match = paramPattern.exec(content)) !== null) {
      const [, name, _typeStr, requiredStr, description] = match;
      const required = requiredStr?.toLowerCase() === 'required';
      const type = this.inferType(name, description);

      parameters.push({
        name,
        type,
        required,
        description: this.cleanText(description)
      });
    }

    // Alternative pattern: | param | type | required | description |
    const tablePattern = /\|\s*(\w+)\s*\|\s*([^|]+)\s*\|\s*(yes|no|true|false|required|optional)\s*\|\s*([^|]+)\s*\|/gi;
    while ((match = tablePattern.exec(content)) !== null) {
      const [, name, _typeStr, requiredStr, description] = match;
      const required = /yes|true|required/i.test(requiredStr);
      const type = this.inferType(name, description);

      // Avoid duplicates
      if (!parameters.find(p => p.name === name)) {
        parameters.push({
          name,
          type,
          required,
          description: this.cleanText(description)
        });
      }
    }

    return parameters;
  }

  private extractResponse(content: string): ParseResult['response'] | undefined {
    // Try to find JSON response examples in code blocks
    const jsonBlockPattern = /```(?:json|javascript)?\s*\n([\s\S]+?)\n```/gi;
    const examples: any[] = [];
    let match;

    while ((match = jsonBlockPattern.exec(content)) !== null) {
      try {
        const json = JSON.parse(match[1]);
        examples.push(json);
      } catch {
        // Not valid JSON, skip
      }
    }

    if (examples.length === 0) return undefined;

    // Try to infer schema from first example
    const schema = this.inferSchema(examples[0]);

    return {
      schema,
      examples
    };
  }

  private inferSchema(obj: any): Record<string, any> {
    if (typeof obj !== 'object' || obj === null) {
      return {};
    }

    const schema: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const type = Array.isArray(value) ? 'array' : typeof value;
      schema[key] = { type };

      if (type === 'array' && Array.isArray(value) && value.length > 0) {
        schema[key].items = this.inferSchema(value[0]);
      } else if (type === 'object' && value !== null) {
        schema[key].properties = this.inferSchema(value);
      }
    }

    return schema;
  }

  private detectStreaming(content: string): boolean {
    const streamingKeywords = ['stream', 'streaming', 'sse', 'server-sent events', 'websocket'];
    return streamingKeywords.some(keyword =>
      content.toLowerCase().includes(keyword)
    );
  }
}
