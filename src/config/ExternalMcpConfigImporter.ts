import { promises as fs } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { McpServiceConfig, Logger, McpVersion } from '../types/index.js';

type SourceName = 'VSCode' | 'Cursor' | 'Windsurf' | 'Claude' | 'Cline';

export interface DiscoveredTemplate {
  source: SourceName;
  path: string;
  items: McpServiceConfig[];
}

export class ExternalMcpConfigImporter {
  private readonly defaultVersion: McpVersion = '2024-11-26' as McpVersion;
  private readonly MAX_JSON_BYTES = 1_000_000; // 1MB 上限，避免 DoS

  constructor(private logger: Logger) {}

  async discoverAll(): Promise<DiscoveredTemplate[]> {
    const results = await Promise.allSettled([
      this.discoverVSCode(),
      this.discoverCursor(),
      this.discoverWindsurf(),
      this.discoverClaude(),
      this.discoverCline()
    ]);

    const flattened: DiscoveredTemplate[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        flattened.push(...r.value);
      }
    }
    return flattened;
  }

  // ========== Individual discoverers ==========
  private async discoverVSCode(): Promise<DiscoveredTemplate[]> {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const appdata = process.env.APPDATA || '';
    const platform = process.platform;
    const candidates: string[] = [];
    // Windows
    if (appdata) candidates.push(join(appdata, 'Code', 'User', 'settings.json'));
    // macOS
    if (home) candidates.push(join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'));
    // Linux
    if (home) candidates.push(join(home, '.config', 'Code', 'User', 'settings.json'));
    for (const target of candidates) {
      const res = await this.discoverFromSettingsFile('VSCode', target, ['mcp.servers']).catch(() => []);
      if (res.length) return res;
    }
    return [];
  }

  private async discoverCursor(): Promise<DiscoveredTemplate[]> {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const appdata = process.env.APPDATA || '';
    const candidates: string[] = [];
    if (appdata) candidates.push(join(appdata, 'Cursor', 'User', 'settings.json'));
    if (home) candidates.push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'));
    if (home) candidates.push(join(home, '.config', 'Cursor', 'User', 'settings.json'));
    for (const target of candidates) {
      const res = await this.discoverFromSettingsFile('Cursor', target, ['mcp.servers']).catch(() => []);
      if (res.length) return res;
    }
    return [];
  }

  private async discoverWindsurf(): Promise<DiscoveredTemplate[]> {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const appdata = process.env.APPDATA || '';
    const candidates: string[] = [];
    if (appdata) candidates.push(join(appdata, 'Windsurf', 'User', 'settings.json'));
    if (home) candidates.push(join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'settings.json'));
    if (home) candidates.push(join(home, '.config', 'Windsurf', 'User', 'settings.json'));
    for (const target of candidates) {
      const res = await this.discoverFromSettingsFile('Windsurf', target, ['mcp.servers']).catch(() => []);
      if (res.length) return res;
    }
    return [];
  }

  private async discoverClaude(): Promise<DiscoveredTemplate[]> {
    // Try both APPDATA and LOCALAPPDATA; look for JSON containing mcpServers
    const candidates: string[] = [];
    const appdata = process.env.APPDATA || '';
    const local = process.env.LOCALAPPDATA || '';
    if (appdata) candidates.push(join(appdata, 'Claude'));
    if (local) candidates.push(join(local, 'Claude'));
    return this.searchForMcpServers('Claude', candidates, 2);
  }

  private async discoverCline(): Promise<DiscoveredTemplate[]> {
    // Cline may store configs under its app dir; also check VSCode-like settings
    const base = process.env.APPDATA || process.env.HOME || '';
    const candidates: string[] = [
      join(base, 'Cline', 'config'),
      join(base, 'Cline'),
      join(base, 'Code', 'User'),
      join(base, 'Cursor', 'User')
    ];
    const results: DiscoveredTemplate[] = [];
    for (const dir of candidates) {
      const fromSettings = await this.discoverFromSettingsFile('Cline', join(dir, 'settings.json'), ['mcp.servers', 'mcpServers']).catch(() => []);
      if (fromSettings.length > 0) results.push(...fromSettings);
      const fromScan = await this.searchForMcpServers('Cline', [dir], 1).catch(() => []);
      if (fromScan.length > 0) results.push(...fromScan);
    }
    return results;
  }

  // ========== Core scanning helpers ==========
  private async discoverFromSettingsFile(source: SourceName, filePath: string, keys: string[]): Promise<DiscoveredTemplate[]> {
    try {
      // 文件大小限制与存在性检查
      const st = await fs.stat(filePath).catch(() => null as any);
      if (!st || !st.isFile() || st.size > this.MAX_JSON_BYTES) return [];
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = this.safeParseJson(raw);
      if (!json) return [];

      const items: McpServiceConfig[] = [];

      // VS Code style: "mcp.servers": [ { name, command, args, env } ]
      if (json['mcp.servers'] && Array.isArray(json['mcp.servers'])) {
        for (const entry of json['mcp.servers'] as any[]) {
          const mapped = this.mapServerEntryToTemplate(entry);
          if (mapped) items.push(mapped);
        }
      }

      // Generic style: mcpServers: { name: { ... } } or [ ... ]
      if (json['mcpServers']) {
        const m = this.mapMcpServersBlock(json['mcpServers']);
        items.push(...m);
      }

      if (items.length === 0) return [];
      return [{ source, path: filePath, items }];
    } catch (e) {
      return [];
    }
  }

  private async searchForMcpServers(source: SourceName, baseDirs: string[], depth: number): Promise<DiscoveredTemplate[]> {
    const results: DiscoveredTemplate[] = [];
    for (const base of baseDirs) {
      const files = await this.findJsonFiles(base, depth).catch(() => [] as string[]);
      for (const f of files) {
        try {
          const st = await fs.stat(f).catch(() => null as any);
          if (!st || !st.isFile() || st.size > this.MAX_JSON_BYTES) continue;
          const raw = await fs.readFile(f, 'utf-8');
          if (!raw.includes('mcpServers') && !raw.includes('mcp.servers')) continue;
          const json = this.safeParseJson(raw);
          if (!json) continue;
          const items: McpServiceConfig[] = [];
          if (json['mcpServers']) items.push(...this.mapMcpServersBlock(json['mcpServers']));
          if (json['mcp.servers']) {
            for (const entry of json['mcp.servers'] as any[]) {
              const mapped = this.mapServerEntryToTemplate(entry);
              if (mapped) items.push(mapped);
            }
          }
          if (items.length > 0) results.push({ source, path: f, items });
        } catch {}
      }
    }
    return results;
  }

  private async findJsonFiles(baseDir: string, depth: number): Promise<string[]> {
    const acc: string[] = [];
    const baseResolved = this.normPath(resolve(baseDir));
    const walk = async (dir: string, d: number) => {
      if (d < 0) return;
      let entries: any[] = [];
      try {
        const fsP = await import('fs/promises');
        entries = await fsP.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const name = (e as any).name || '';
        const full = resolve(dir, name);
        const normFull = this.normPath(full);
        // 白名单：仅遍历 baseDir 子路径
        if (!this.isSubPath(baseResolved, normFull)) continue;
        if ((e as any).isSymbolicLink?.()) continue; // 跳过符号链接
        if ((e as any).isDirectory?.()) {
          await walk(full, d - 1);
        } else if (normFull.toLowerCase().endsWith('.json')) {
          acc.push(full);
        }
      }
    };
    await walk(baseDir, depth);
    return acc;
  }

  // ========== Mapping ==========
  private mapMcpServersBlock(block: any): McpServiceConfig[] {
    const out: McpServiceConfig[] = [];
    if (Array.isArray(block)) {
      for (const entry of block) {
        const mapped = this.mapServerEntryToTemplate(entry);
        if (mapped) out.push(mapped);
      }
    } else if (block && typeof block === 'object') {
      for (const [name, entry] of Object.entries(block)) {
        const mapped = this.mapServerEntryToTemplate({ name, ...(entry as any) });
        if (mapped) out.push(mapped);
      }
    }
    return out;
  }

  private mapServerEntryToTemplate(entry: any): McpServiceConfig | null {
    try {
      const name: string = entry.name || entry.label || entry.id || this.deriveName(entry) || `imported-${Date.now()}`;
      const env: Record<string, string> = {};
      let transport: 'stdio' | 'http' | 'streamable-http' = 'stdio';
      let command: string | undefined = entry.command;
      let args: string[] | undefined = entry.args;

      // URL-based (HTTP / Streamable HTTP)
      const url: string | undefined = entry.url || entry.serverUrl || entry.endpoint || entry.baseUrl;
      if (url) {
        if (!this.isValidHttpUrl(url)) return null;
        transport = url.includes('/sse') ? 'streamable-http' : 'http';
        env['MCP_SERVER_URL'] = url;
      }

      // Headers mapping
      const headers: Record<string, string> | undefined = entry.headers || entry.httpHeaders;
      if (headers && Object.keys(headers).length > 0) {
        env['HTTP_HEADERS'] = JSON.stringify(headers);
        const auth = headers['Authorization'] || headers['authorization'];
        if (auth && auth.startsWith('Bearer ')) {
          env['API_KEY'] = auth.substring(7);
        }
        if (headers['X-API-Token']) {
          env['API_TOKEN'] = headers['X-API-Token'];
        }
      }

      // If only stdio is defined (command present)
      if (!url && command) {
        transport = 'stdio';
      }

      // Ensure args array
      if (command && !Array.isArray(args)) {
        args = typeof entry.args === 'string' ? [entry.args] : (Array.isArray(entry.args) ? entry.args : []);
      }

      const cfg: McpServiceConfig = {
        name,
        version: this.defaultVersion,
        transport: transport as any,
        command,
        args,
        env: Object.keys(env).length > 0 ? env : undefined,
        timeout: typeof entry.timeout === 'number' ? entry.timeout : 30000,
        retries: typeof entry.retries === 'number' ? entry.retries : 3
      };

      return cfg;
    } catch (e) {
      this.logger.warn('Failed to map external MCP server entry', { error: (e as Error).message });
      return null;
    }
  }

  private deriveName(entry: any): string | undefined {
    if (entry.url) {
      try {
        const u = new URL(entry.url);
        return `${u.hostname}-${u.pathname.replace(/\//g, '-')}`.replace(/-+/g, '-');
      } catch {}
    }
    if (entry.command) {
      const base = (entry.command as string).split(/[\\/]/).pop();
      return base || undefined;
    }
    return undefined;
  }

  private safeParseJson(raw: string): any | null {
    try {
      return JSON.parse(raw);
    } catch {
      // VS Code settings.json 可能不是严格 JSON（尾逗号/注释），这里做简单修复
      const stripped = raw
        .replace(/\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(stripped);
      } catch {
        return null;
      }
    }
  }

  // ===== Helpers =====
  private normPath(p: string): string { return p.replace(/\\/g, '/'); }
  private isSubPath(base: string, target: string): boolean {
    const b = base.endsWith('/') ? base : base + '/';
    return target.startsWith(b);
  }
  private isValidHttpUrl(u: string): boolean {
    try {
      const parsed = new URL(u);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
}


