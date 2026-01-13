import path from 'path';
import { mkdir, readdir, rm, stat, watch as watchAsync, writeFile } from 'fs/promises';
import type { Dirent } from 'fs';
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import type { Logger } from '../types/index.js';
import { mergeWithDefaults, validateCapabilities } from '../security/CapabilityManifest.js';
import type { SkillCapabilities } from '../security/CapabilityManifest.js';
import type { Skill, SkillMetadata } from './types.js';
import { SkillLoader } from './SkillLoader.js';

const SkillCapabilitiesSchema = z.object({
  filesystem: z.object({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional()
  }).partial().optional(),
  network: z.object({
    allowedHosts: z.array(z.string()).optional(),
    allowedPorts: z.array(z.union([z.number(), z.string()])).optional()
  }).partial().optional(),
  env: z.array(z.string()).optional(),
  subprocess: z.object({
    allowed: z.boolean().optional(),
    allowedCommands: z.array(z.string()).optional()
  }).partial().optional(),
  resources: z.object({
    maxMemoryMB: z.union([z.number(), z.string()]).optional(),
    maxCpuPercent: z.union([z.number(), z.string()]).optional(),
    timeoutMs: z.union([z.number(), z.string()]).optional()
  }).partial().optional()
}).partial();

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: z.object({
    'short-description': z.string().optional(),
    keywords: z.array(z.string()).optional(),
    tags: z.record(z.string()).optional(),
    traits: z.array(z.string()).optional(),
    allowedTools: z.string().optional(),
    priority: z.number().optional()
  }).partial().optional(),
  capabilities: SkillCapabilitiesSchema.optional()
}).partial();

const WATCH_DEBOUNCE_MS = 500;
const DEFAULT_WATCH_MAX_DEPTH = 5;
const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'generated',
  'release'
]);

export interface RegisterSkillInput {
  name: string;
  description: string;
  body: string;
  shortDescription?: string;
  keywords?: string[];
  tags?: Record<string, string>;
  traits?: string[];
  allowedTools?: string;
  priority?: number;
  capabilities?: Partial<SkillCapabilities>;
  supportFiles?: Array<{ path: string; content: string }>;
  overwrite?: boolean;
}

function normalizeName(name: string): string {
  return name.trim();
}

function safeDirName(name: string): string {
  const normalized = normalizeName(name).toLowerCase();
  // Keep Codex-like naming: letters/digits/-/_ only, collapse others to '-'.
  return normalized
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function ensureRelativeWithin(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..')) {
    throw new Error(`Invalid support file path: ${rel}`);
  }
  const abs = path.resolve(root, cleaned);
  const resolvedRoot = path.resolve(root);
  if (!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) {
    throw new Error(`Invalid support file path: ${rel}`);
  }
  return abs;
}

type AsyncFsWatcher = AsyncIterable<{ eventType: string; filename?: string | Buffer }> & { close?: () => void };
type WatcherEntry = { watcher: AsyncFsWatcher; root: string; depth: number };

export class SkillRegistry {
  private readonly logger?: Logger;
  private readonly loader: SkillLoader;
  private readonly skills = new Map<string, Skill>();
  private readonly roots: string[];
  private readonly managedRoot: string;
  private watchEnabled = false;
  private readonly watchers = new Map<string, WatcherEntry>();
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options?: { logger?: Logger; roots?: string[]; managedRoot?: string; loader?: SkillLoader }) {
    this.logger = options?.logger;
    this.roots = options?.roots && options.roots.length ? options.roots : undefined as any;
    this.managedRoot = options?.managedRoot ?? path.resolve(process.cwd(), 'config', 'skills');
    this.loader = options?.loader ?? new SkillLoader({ logger: this.logger });
    const baseRoots = options?.roots && options.roots.length ? options.roots : this.loader.getDefaultRoots();
    // Always include managedRoot so /api/skills/register persists and can be reloaded.
    this.roots = Array.from(new Set([this.managedRoot, ...baseRoots]));
  }

  getManagedRoot(): string {
    return this.managedRoot;
  }

  async reload(): Promise<void> {
    const loaded = await this.loader.loadAllSkills(this.roots);
    this.skills.clear();
    for (const skill of loaded) {
      this.skills.set(skill.metadata.name.toLowerCase(), skill);
    }
  }

  list(): SkillMetadata[] {
    return Array.from(this.skills.values()).map((s) => s.metadata);
  }

  all(): Skill[] {
    return Array.from(this.skills.values());
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name.toLowerCase());
  }

  async register(input: RegisterSkillInput): Promise<Skill> {
    const name = normalizeName(input.name);
    if (!name) throw new Error('Skill name is required');
    const dir = safeDirName(name);
    if (!dir) throw new Error('Skill name is invalid');

    const skillDir = path.join(this.managedRoot, dir);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    const overwrite = Boolean(input.overwrite);
    if (!overwrite && this.skills.has(name.toLowerCase())) {
      throw new Error(`Skill already exists: ${name}`);
    }

    await mkdir(skillDir, { recursive: true });

    const capabilities = mergeWithDefaults(input.capabilities as any);
    validateCapabilities(capabilities);

    const frontmatter = SkillFrontmatterSchema.parse({
      name,
      description: input.description,
      metadata: {
        'short-description': input.shortDescription,
        keywords: input.keywords,
        tags: input.tags,
        traits: input.traits,
        allowedTools: input.allowedTools,
        priority: input.priority
      },
      capabilities
    });

    const yamlText = stringifyYaml(frontmatter).trimEnd();
    const full = `---\n${yamlText}\n---\n\n${input.body.trim()}\n`;
    await writeFile(skillMdPath, full, 'utf8');

    if (input.supportFiles && input.supportFiles.length) {
      for (const f of input.supportFiles) {
        const rel = String(f.path || '').trim();
        const abs = ensureRelativeWithin(skillDir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, String(f.content ?? ''), 'utf8');
      }
    }

    const loaded = await this.loader.loadSkillFromSkillMd(skillMdPath);
    if (!loaded) throw new Error('Failed to load newly registered skill');
    this.skills.set(loaded.metadata.name.toLowerCase(), loaded);
    return loaded;
  }

  async delete(name: string): Promise<boolean> {
    const skill = this.get(name);
    if (!skill) return false;
    const skillPath = path.resolve(skill.metadata.path);
    const managedRoot = path.resolve(this.managedRoot) + path.sep;
    if (!skillPath.startsWith(managedRoot)) {
      throw new Error('Skill is not managed by this Nexus instance');
    }

    const dir = path.dirname(skillPath);
    await rm(dir, { recursive: true, force: true });
    this.skills.delete(name.toLowerCase());
    return true;
  }

  async startWatch(): Promise<void> {
    if (this.watchEnabled) {
      return;
    }

    this.watchEnabled = true;
    this.logger?.info('Starting SkillRegistry watch', { roots: this.roots });

    for (const root of this.roots) {
      await this.watchRoot(root);
    }

    this.logger?.info('SkillRegistry watch started', {
      roots: this.roots.length,
      watchedDirs: this.watchers.size
    });
  }

  stopWatch(): void {
    if (!this.watchEnabled) {
      return;
    }

    this.watchEnabled = false;
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = undefined;
    }

    for (const entry of this.watchers.values()) {
      try {
        entry.watcher?.close?.();
      } catch {
        // ignored
      }
    }
    this.watchers.clear();

    this.logger?.info('SkillRegistry watch stopped');
  }

  private scheduleReload(meta?: { root?: string; dir?: string; filename?: string; eventType?: string }): void {
    if (!this.watchEnabled) return;

    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }

    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = undefined;
      if (!this.watchEnabled) return;

      this.logger?.info('Reloading skills (watch)', meta);
      this.reload().catch((error) => {
        this.logger?.warn('Failed to reload skills (watch)', {
          ...meta,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, WATCH_DEBOUNCE_MS);
  }

  private async watchRoot(root: string): Promise<void> {
    const resolvedRoot = path.resolve(root);
    try {
      await this.watchDirectoryTree(resolvedRoot, resolvedRoot, 0);
    } catch (error) {
      this.logger?.warn('Failed to start watching skills root', {
        root: resolvedRoot,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async watchDirectoryTree(root: string, dir: string, depth: number): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir, depth }];
    const seen = new Set<string>();

    while (queue.length && this.watchEnabled) {
      const next = queue.shift();
      if (!next) break;

      const currentDir = path.resolve(next.dir);
      const currentDepth = next.depth;
      if (currentDepth > DEFAULT_WATCH_MAX_DEPTH) continue;
      if (seen.has(currentDir)) continue;
      seen.add(currentDir);

      await this.addDirectoryWatcher(root, currentDir, currentDepth);

      let entries: Dirent[];
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        queue.push({ dir: path.join(currentDir, entry.name), depth: currentDepth + 1 });
      }
    }
  }

  private async addDirectoryWatcher(root: string, dir: string, depth: number): Promise<void> {
    const resolvedDir = path.resolve(dir);
    if (this.watchers.has(resolvedDir)) return;

    let watcher: AsyncFsWatcher;
    try {
      watcher = watchAsync(resolvedDir, { persistent: false }) as any;
    } catch (error) {
      this.logger?.warn('Unable to watch skills directory', {
        dir: resolvedDir,
        root,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    this.watchers.set(resolvedDir, { watcher, root, depth });
    this.logger?.debug('Watching skills directory', { dir: resolvedDir });

    (async () => {
      try {
        for await (const event of watcher as any) {
          if (!this.watchEnabled) break;

          const filenameRaw = (event as any)?.filename as string | Buffer | undefined;
          const eventType = (event as any)?.eventType as string | undefined;
          const filename = typeof filenameRaw === 'string'
            ? filenameRaw
            : (filenameRaw ? filenameRaw.toString() : undefined);

          if (!filename) {
            // Some platforms don't reliably provide filenames; reload to be safe.
            this.scheduleReload({ root, dir: resolvedDir, eventType });
            continue;
          }

          if (path.basename(filename).toLowerCase() === 'skill.md') {
            this.scheduleReload({ root, dir: resolvedDir, filename, eventType });
          }

          if (eventType === 'rename') {
            await this.tryWatchChildDirectory(root, resolvedDir, depth, filename);
          }
        }
      } catch (error) {
        if (this.watchEnabled) {
          this.logger?.warn('Skills directory watcher failed', {
            dir: resolvedDir,
            root,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } finally {
        this.watchers.delete(resolvedDir);
        try {
          watcher?.close?.();
        } catch {
          // ignored
        }
      }
    })();
  }

  private async tryWatchChildDirectory(root: string, parentDir: string, parentDepth: number, filename: string): Promise<void> {
    if (!this.watchEnabled) return;
    if (parentDepth >= DEFAULT_WATCH_MAX_DEPTH) return;

    const name = path.basename(filename);
    if (!name || DEFAULT_IGNORED_DIRS.has(name)) return;

    const childPath = path.join(parentDir, filename);
    let st: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      st = await stat(childPath);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) return;

    await this.watchDirectoryTree(root, childPath, parentDepth + 1);
  }
}
