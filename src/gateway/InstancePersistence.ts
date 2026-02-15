import { promises as fs } from 'fs';
import * as path from 'path';
import type { Logger } from '../types/index.js';

export interface PersistedInstance {
  templateName: string;
  overrides?: Record<string, unknown>;
  autostart: boolean;
  createdAt: string;
  lastStartedAt?: string;
}

export interface InstancePersistenceData {
  version: 1;
  instances: Record<string, PersistedInstance>;
}

const DEFAULT_PATH = path.resolve('data', 'instances.json');

export class InstancePersistence {
  private data: InstancePersistenceData = { version: 1, instances: {} };
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;

  constructor(
    private readonly logger: Logger,
    filePath?: string,
  ) {
    this.filePath = filePath ?? DEFAULT_PATH;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as InstancePersistenceData;
      if (parsed.version === 1 && parsed.instances) {
        this.data = parsed;
        this.logger.info('loaded persisted instances', { count: Object.keys(this.data.instances).length });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.info('no persisted instances file, starting fresh');
      } else {
        this.logger.warn('failed to load persisted instances', { err });
      }
    }
  }

  getAutostartEntries(): PersistedInstance[] {
    return Object.values(this.data.instances).filter(i => i.autostart);
  }

  getAllEntries(): Record<string, PersistedInstance> {
    return { ...this.data.instances };
  }

  track(serviceId: string, templateName: string, overrides?: Record<string, unknown>, autostart = true): void {
    this.data.instances[serviceId] = {
      templateName,
      overrides,
      autostart,
      createdAt: new Date().toISOString(),
      lastStartedAt: new Date().toISOString(),
    };
    this.scheduleSave();
  }

  untrack(serviceId: string): void {
    if (this.data.instances[serviceId]) {
      delete this.data.instances[serviceId];
      this.scheduleSave();
    }
  }

  markStarted(serviceId: string): void {
    const entry = this.data.instances[serviceId];
    if (entry) {
      entry.lastStartedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  setAutostart(serviceId: string, autostart: boolean): void {
    const entry = this.data.instances[serviceId];
    if (entry) {
      entry.autostart = autostart;
      this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 500);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error('failed to persist instances', { err });
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}
