import path from 'path';
import { mkdir, rm, writeFile } from 'fs/promises';
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

export class SkillRegistry {
  private readonly logger?: Logger;
  private readonly loader: SkillLoader;
  private readonly skills = new Map<string, Skill>();
  private readonly roots: string[];
  private readonly managedRoot: string;

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
}
