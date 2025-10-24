import { BaseParser } from './BaseParser.js';
import type { ParseResult, Logger } from '../../types/index.js';

/**
 * Text Parser
 * Parses simple text, HTTP lines, or curl commands into a ParseResult
 */
export class TextParser extends BaseParser {
  constructor(logger: Logger) {
    super(logger);
  }

  supports(content: string): boolean {
    // Heuristics: method URL on one line or a curl command
    return /^(GET|POST|PUT|DELETE|PATCH)\s+https?:\/\//mi.test(content)
      || /^curl\s+https?:\/\//mi.test(content)
      || /https?:\/\//.test(content);
  }

  async parse(content: string): Promise<ParseResult> {
    this.logger.debug('Parsing Text content');

    // Try curl first
    const curlMatch = content.match(/^curl\s+([^\n]+)/mi);
    if (curlMatch) {
      return this.parseCurlLine(curlMatch[0]);
    }

    // Try METHOD URL line
    const methodUrl = content.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/\S+)/mi);
    if (methodUrl) {
      const method = methodUrl[1].toUpperCase() as any;
      const url = methodUrl[2];
      const { baseUrl, path } = this.normalizeUrl(url);
      return {
        intent: this.extractIntent(content),
        endpoint: { url: path, method, baseUrl: baseUrl || undefined },
        parameters: [],
        response: undefined
      };
    }

    // Fallback: any URL
    const urlOnly = content.match(/https?:\/\/\S+/);
    if (!urlOnly) {
      throw new Error('No URL found in text');
    }
    const { baseUrl, path } = this.normalizeUrl(urlOnly[0]);
    return {
      intent: this.extractIntent(content),
      endpoint: { url: path, method: 'GET', baseUrl: baseUrl || undefined },
      parameters: [],
      response: undefined
    };
  }

  private parseCurlLine(line: string): ParseResult {
    // Very lightweight curl parser: method from -X or default GET; URL first arg after curl
    const tokens = this.tokenize(line);
    let method: any = 'GET';
    let url = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if ((t === '-X' || t === '--request') && tokens[i + 1]) {
        method = tokens[i + 1].toUpperCase();
        i++;
        continue;
      }
      if (!t.startsWith('-') && t.startsWith('http')) {
        url = t;
        break;
      }
    }
    if (!url) {
      // Another common form: curl "URL"
      const urlMatch = line.match(/curl\s+(['"]?)(https?:\/\/[^'"\s]+)\1/);
      url = urlMatch?.[2] || '';
    }
    if (!url) throw new Error('No URL found in curl command');

    const { baseUrl, path } = this.normalizeUrl(url);
    return {
      intent: 'HTTP request',
      endpoint: { url: path, method, baseUrl: baseUrl || undefined },
      parameters: [],
      response: undefined
    };
  }

  private tokenize(s: string): string[] {
    // crude shell-like tokenizer for quotes
    const out: string[] = [];
    let cur = '';
    let q: '"' | "'" | null = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === q) { q = null; continue; }
        cur += c; continue;
      }
      if (c === '"' || c === "'") { q = c; continue; }
      if (/\s/.test(c)) { if (cur) { out.push(cur); cur=''; } continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }
}

