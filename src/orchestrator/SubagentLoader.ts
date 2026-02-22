import { promises as fs } from 'fs';
import { join } from 'path';
import { Logger, SubagentConfig, SubagentConfigSchema } from '../types/index.js';

export class SubagentLoader {
  private readonly logger: Logger;
  private readonly dir: string;
  private cache: Map<string, SubagentConfig> = new Map();
  private loadLock = Promise.resolve();

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger;
  }

  async loadAll(): Promise<Map<string, SubagentConfig>> {
    const prevLock = this.loadLock;
    let release!: () => void;
    this.loadLock = new Promise<void>(r => { release = r; });
    await prevLock;
    try {
    const map = new Map<string, SubagentConfig>();
    try {
      const files = await fs.readdir(this.dir);
      for (const f of files) {
        // 仅允许形如 name.json 的文件，过滤可疑文件名
        if (!/^[a-zA-Z0-9._-]+\.json$/.test(f)) continue;
        const full = join(this.dir, f);
        try {
          const st = await fs.stat(full);
          if (!st.isFile()) continue;
          const raw = await fs.readFile(full, 'utf-8');
          const parsed = JSON.parse(raw);
          const cfg = SubagentConfigSchema.parse(parsed);
          map.set(cfg.name, cfg);
        } catch (err: unknown) {
          this.logger.warn('Failed to load subagent config', { file: full, error: (err as Error)?.message || String(err) });
        }
      }
      this.cache = map;
      this.logger.info('Subagents loaded', { count: map.size, dir: this.dir });
    } catch (err: unknown) {
      this.logger.warn('Failed to read subagents directory', { dir: this.dir, error: (err as Error)?.message || String(err) });
    }
    return this.cache;
    } finally {
      release();
    }
  }

  get(name: string): SubagentConfig | undefined {
    return this.cache.get(name);
  }

  list(): SubagentConfig[] {
    return Array.from(this.cache.values());
  }
}

