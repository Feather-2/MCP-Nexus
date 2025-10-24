import type { ParseResult, Logger } from '../../types/index.js';

/**
 * Base Parser Interface
 * All parsers must implement this interface
 */
export interface IParser {
  parse(content: string): Promise<ParseResult>;
  supports(content: string): boolean;
}

/**
 * Abstract base class for parsers
 */
export abstract class BaseParser implements IParser {
  protected logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  abstract parse(content: string): Promise<ParseResult>;
  abstract supports(content: string): boolean;

  /**
   * Extract intent/description from various formats
   */
  protected extractIntent(content: string): string {
    // Try to find common description patterns
    const patterns = [
      /(?:description|desc|summary):\s*(.+?)(?:\n|$)/i,
      /^#\s+(.+?)$/m,  // Markdown title
      /^##\s+(.+?)$/m, // Markdown subtitle
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    // Fallback: use first line
    const firstLine = content.split('\n')[0].trim();
    return firstLine || 'Auto-generated MCP tool';
  }

  /**
   * Infer parameter type from description or example
   */
  protected inferType(paramName: string, description?: string, example?: any): 'string' | 'number' | 'boolean' | 'object' | 'array' {
    if (example !== undefined) {
      const type = typeof example;
      if (type === 'string' || type === 'number' || type === 'boolean') {
        return type;
      }
      if (Array.isArray(example)) return 'array';
      if (type === 'object') return 'object';
    }

    // Infer from name patterns
    const lowerName = paramName.toLowerCase();
    if (lowerName.includes('count') || lowerName.includes('size') || lowerName.includes('limit')) {
      return 'number';
    }
    if (lowerName.includes('is') || lowerName.includes('has') || lowerName.includes('enabled')) {
      return 'boolean';
    }
    if (lowerName.includes('list') || lowerName.includes('items') || lowerName.includes('array')) {
      return 'array';
    }

    return 'string'; // Default
  }

  /**
   * Normalize URL
   */
  protected normalizeUrl(url: string): { baseUrl: string; path: string } {
    try {
      const urlObj = new URL(url);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      const path = urlObj.pathname + urlObj.search;
      return { baseUrl, path };
    } catch {
      // If not a full URL, assume it's a path
      return { baseUrl: '', path: url };
    }
  }

  /**
   * Extract query parameters from URL
   */
  protected extractQueryParams(url: string): Array<{ name: string; value: string }> {
    try {
      const urlObj = new URL(url);
      const params: Array<{ name: string; value: string }> = [];
      urlObj.searchParams.forEach((value, name) => {
        params.push({ name, value });
      });
      return params;
    } catch {
      return [];
    }
  }

  /**
   * Clean and format text
   */
  protected cleanText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
  }
}
