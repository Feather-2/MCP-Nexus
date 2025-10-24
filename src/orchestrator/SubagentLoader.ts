import { promises as fs } from 'fs';
import { join } from 'path';
import { Logger, SubagentConfig, SubagentConfigSchema } from '../types/index.js';

export class SubagentLoader {
  private readonly logger: Logger;
  private readonly dir: string;
  private cache: Map<string, SubagentConfig> = new Map();

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger;
  }

  async loadAll(): Promise<Map<string, SubagentConfig>> {
    const map = new Map<string, SubagentConfig>();
    try {
      const files = await fs.readdir(this.dir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const full = join(this.dir, f);
        try {
          const raw = await fs.readFile(full, 'utf-8');
          const parsed = JSON.parse(raw);
          const cfg = SubagentConfigSchema.parse(parsed);
          map.set(cfg.name, cfg);
        } catch (err: any) {
          this.logger.warn('Failed to load subagent config', { file: full, error: err?.message || String(err) });
        }
      }
      this.cache = map;
      this.logger.info('Subagents loaded', { count: map.size, dir: this.dir });
    } catch (err: any) {
      this.logger.warn('Failed to read subagents directory', { dir: this.dir, error: err?.message || String(err) });
    }
    return this.cache;
  }

  get(name: string): SubagentConfig | undefined {
    return this.cache.get(name);
  }

  list(): SubagentConfig[] {
    return Array.from(this.cache.values());
  }
}

