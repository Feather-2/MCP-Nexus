import { BaseParser } from './BaseParser.js';
import type { ParseResult, Logger } from '../../types/index.js';

/**
 * OpenAPI Parser (MVP)
 * - Supports JSON OpenAPI 3.x documents
 * - Heuristics: pick first available path+method
 * - Extracts baseUrl from servers[0].url
 * - Extracts parameters (name, required, description)
 * - Detects simple auth from components.securitySchemes + security
 */
export class OpenApiParser extends BaseParser {
  constructor(logger: Logger) {
    super(logger);
  }

  supports(content: string): boolean {
    // Fast heuristic: JSON or YAML openapi indicators
    if (/"openapi"\s*:\s*"\d/.test(content)) return true; // JSON
    if (/^openapi\s*:\s*["']?\d/m.test(content)) return true; // YAML
    // Try JSON parse (best effort)
    try {
      const obj = JSON.parse(content);
      return !!obj && (obj.openapi || obj.swagger);
    } catch {
      return false;
    }
  }

  async parse(content: string): Promise<ParseResult> {
    let doc: any;
    try {
      doc = JSON.parse(content);
    } catch (e) {
      // YAML fallback (runtime dynamic import; avoids TS type resolution)
      try {
        const dynamicImport: any = new Function('m', 'return import(m)');
        const mod: any = await dynamicImport('yaml');
        const parsed = mod?.parse ? mod.parse(content) : null;
        if (!parsed) throw new Error('YAML parser not available');
        doc = parsed;
      } catch (ye) {
        throw new Error('Failed to parse OpenAPI: content is not valid JSON; YAML parse not available');
      }
    }

    const baseUrl = this.extractBaseUrl(doc);
    const { path, method } = this.pickFirstOperation(doc);
    const parameters = this.extractParameters(doc, path, method);
    const auth = this.detectAuth(doc);

    return {
      intent: this.extractIntentFromDoc(doc) || 'OpenAPI generated service',
      endpoint: {
        url: path,
        method: method.toUpperCase() as any,
        baseUrl: baseUrl || undefined
      },
      auth: auth || undefined,
      parameters,
      response: undefined,
      hasStatefulLogic: false,
      hasLocalProcessing: false,
      supportsStreaming: false
    };
  }

  private extractBaseUrl(doc: any): string {
    const servers = doc.servers;
    if (Array.isArray(servers) && servers.length > 0 && typeof servers[0].url === 'string') {
      return servers[0].url;
    }
    return '';
  }

  private pickFirstOperation(doc: any): { path: string; method: string } {
    const paths = doc.paths || {};
    const methods = ['get', 'post', 'put', 'delete', 'patch'];
    type Cand = { path: string; method: string; op: any; score: number };
    const cands: Cand[] = [];
    for (const p of Object.keys(paths)) {
      for (const m of methods) {
        const op = paths[p]?.[m];
        if (!op) continue;
        let score = 0;
        if (m === 'get') score += 1;
        if (m === 'post' && op.requestBody) score += 2; // prefer POST with body
        const sum = (op.summary || op.operationId || '').toString().toLowerCase();
        if (/search|list|query/.test(sum)) score += 1;
        if (Array.isArray(op.tags) && op.tags.includes('default')) score += 1;
        cands.push({ path: p, method: m, op, score });
      }
    }
    if (cands.length === 0) throw new Error('No operation found in OpenAPI document');
    cands.sort((a, b) => b.score - a.score);
    const top = cands[0];
    return { path: top.path, method: top.method };
  }

  private extractParameters(doc: any, pathKey: string, method: string): ParseResult['parameters'] {
    const op = (doc.paths?.[pathKey] || {})[method] || {};
    const params: any[] = [];
    const addParams = (arr: any[]) => {
      for (const p of arr || []) {
        if (!p || !p.name) continue;
        const param = {
          name: String(p.name),
          type: this.mapSchemaType(p.schema) || 'string',
          required: !!p.required,
          description: typeof p.description === 'string' ? p.description : undefined
        };
        if (!params.find((x: any) => x.name === param.name)) params.push(param);
      }
    };
    addParams(doc.paths?.[pathKey]?.parameters);
    addParams(op.parameters);
    // Request body (application/json preferred)
    const body = op.requestBody;
    const content = body?.content || {};
    const mime = content['application/json'] ? 'application/json' : (Object.keys(content)[0] || '');
    if (mime && content[mime]?.schema) {
      const schema = content[mime].schema;
      const bodyParams = this.flattenSchemaToParams(schema);
      for (const bp of bodyParams) {
        if (!params.find((x: any) => x.name === bp.name)) params.push(bp);
      }
    }
    return params;
  }

  private mapSchemaType(schema: any): 'string'|'number'|'boolean'|'object'|'array' {
    const t = schema?.type;
    if (t === 'integer' || t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'array') return 'array';
    if (t === 'object') return 'object';
    return 'string';
  }

  private flattenSchemaToParams(schema: any): Array<{ name: string; type: any; required: boolean; description?: string }> {
    const out: Array<{ name: string; type: any; required: boolean; description?: string }> = [];
    if (!schema) return out;
    // Resolve $ref rudimentarily (components.schemas)
    const resolveRef = (ref: string): any => {
      // Expect '#/components/schemas/Name'
      const parts = ref.split('/');
      const name = parts[parts.length - 1];
      const comp = (this as any).doc?.components?.schemas?.[name];
      return comp || {};
    };
    const s = schema.$ref ? resolveRef(schema.$ref) : schema;
    if (s.type === 'object' && s.properties) {
      const reqSet = new Set<string>((s.required || []) as string[]);
      for (const [k, v] of Object.entries<any>(s.properties)) {
        const type = this.mapSchemaType(v);
        const required = reqSet.has(k);
        out.push({ name: k, type, required, description: typeof v.description === 'string' ? v.description : undefined });
      }
    } else {
      out.push({ name: 'data', type: this.mapSchemaType(s), required: !!schema.required });
    }
    return out;
  }

  private detectAuth(doc: any): ParseResult['auth'] | null {
    const sec = doc.security || [];
    const schemes = doc.components?.securitySchemes || {};
    if (!Array.isArray(sec) || sec.length === 0) return null;
    for (const req of sec) {
      const keys = Object.keys(req || {});
      for (const k of keys) {
        const sch = schemes[k];
        if (!sch) continue;
        const type = String(sch.type || '').toLowerCase();
        if (type === 'apiKey') {
          return { type: 'apikey', location: (sch.in === 'query' ? 'query' : 'header'), key: sch.name || 'Authorization' } as any;
        }
        if (type === 'http' && (sch.scheme === 'bearer' || sch.scheme === 'basic')) {
          return { type: sch.scheme === 'basic' ? 'basic' : 'bearer', location: 'header', key: 'Authorization' } as any;
        }
        if (type === 'oauth2') {
          return { type: 'oauth2', location: 'header', key: 'Authorization' } as any;
        }
      }
    }
    return null;
  }

  private extractIntentFromDoc(doc: any): string | null {
    return (doc.info && (doc.info.title || doc.info.description)) || null;
  }
}
