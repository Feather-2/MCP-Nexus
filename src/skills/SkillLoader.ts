import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { access, readdir, readFile, stat } from 'fs/promises';
import { constants } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { Logger } from '../types/index.js';
import { mergeWithDefaults, validateCapabilities, type SkillCapabilities } from '../security/CapabilityManifest.js';
import type { Skill, SkillMetadata, SkillScope } from './types.js';
import { SkillVersionTracker } from './SkillVersionTracker.js';
import { SkillDiffAnalyzer } from './SkillDiffAnalyzer.js';
import { SkillRiskAccumulator } from './SkillRiskAccumulator.js';
import type { SkillModificationApprover } from './SkillModificationApprover.js';

export interface SkillLoaderOptions {
  logger?: Logger;
  maxDepth?: number;
  /**
   * HMAC secret used to verify `signature` in SKILL.md frontmatter.
   */
  signatureSecret?: string;
  /**
   * Require every skill to provide a valid frontmatter `signature`.
   * Defaults to true when a signatureSecret is configured.
   */
  enforceSignatures?: boolean;
  /**
   * When true, reads text files under scripts/ and references/ into `skill.supportFiles`.
   * Binary files (assets) are skipped.
   */
  loadSupportFiles?: boolean;
  /**
   * Maximum bytes per support file (default: 256KB).
   */
  maxSupportFileBytes?: number;
  /**
   * Enable version tracking and risk analysis for skills.
   */
  enableVersionTracking?: boolean;
  /**
   * Storage root for version history (default: process.cwd()).
   */
  versionStorageRoot?: string;
  /**
   * Optional approver for skill modifications that exceed risk thresholds.
   */
  approver?: SkillModificationApprover;
}

type CachedSkill = { hash: string; skill: Skill };

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'generated',
  'release'
]);

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeToken(v);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
  return matches
    .map((t) => t.trim())
    .filter(Boolean);
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function inferScope(skillMdPath: string, cwd: string): SkillScope {
  const normalized = path.resolve(skillMdPath);
  const home = os.homedir();
  const codexSkills = path.resolve(home, '.codex', 'skills');
  const codexSystemSkills = path.resolve(codexSkills, '.system');
  const resolvedCwd = path.resolve(cwd);

  if (normalized.startsWith(codexSystemSkills + path.sep)) return 'system';
  if (normalized.startsWith(codexSkills + path.sep)) return 'user';
  if (normalized.startsWith(resolvedCwd + path.sep)) return 'repo';
  return 'user';
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseTags(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHexSignature(value: string): string {
  const trimmed = value.trim().replace(/^sha256[:=]/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error('Skill signature must be a 64-char SHA-256 hex string');
  }
  return trimmed;
}

function stripSignatureField(frontmatter: unknown): Record<string, unknown> {
  if (!isPlainObject(frontmatter)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'signature') continue;
    out[key] = value;
  }
  return out;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function buildSignaturePayload(frontmatter: unknown, body: string): string {
  return JSON.stringify({
    frontmatter: canonicalize(stripSignatureField(frontmatter)),
    body: body.replace(/\r\n/g, '\n')
  });
}

function computeSkillSignature(frontmatter: unknown, body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(buildSignaturePayload(frontmatter, body), 'utf8').digest('hex');
}

function safeHexEqual(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch (_e) {
    return false;
  }
}

function requireCapabilityKeys(raw: unknown, skillName: string): void {
  if (!isPlainObject(raw)) {
    throw new Error(`Skill "${skillName}" capabilities must be an object`);
  }
  const requiredTop = ['filesystem', 'network', 'env', 'subprocess', 'resources'];
  for (const key of requiredTop) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`Skill "${skillName}" capabilities.${key} is required`);
    }
  }

  const fs = raw['filesystem'];
  if (!isPlainObject(fs)) throw new Error(`Skill "${skillName}" capabilities.filesystem must be an object`);
  for (const key of ['read', 'write']) {
    if (!Object.prototype.hasOwnProperty.call(fs, key)) {
      throw new Error(`Skill "${skillName}" capabilities.filesystem.${key} is required`);
    }
  }

  const net = raw['network'];
  if (!isPlainObject(net)) throw new Error(`Skill "${skillName}" capabilities.network must be an object`);
  for (const key of ['allowedHosts', 'allowedPorts']) {
    if (!Object.prototype.hasOwnProperty.call(net, key)) {
      throw new Error(`Skill "${skillName}" capabilities.network.${key} is required`);
    }
  }

  const env = raw['env'];
  if (!Array.isArray(env)) throw new Error(`Skill "${skillName}" capabilities.env must be an array`);

  const sub = raw['subprocess'];
  if (!isPlainObject(sub)) throw new Error(`Skill "${skillName}" capabilities.subprocess must be an object`);
  for (const key of ['allowed', 'allowedCommands']) {
    if (!Object.prototype.hasOwnProperty.call(sub, key)) {
      throw new Error(`Skill "${skillName}" capabilities.subprocess.${key} is required`);
    }
  }

  const res = raw['resources'];
  if (!isPlainObject(res)) throw new Error(`Skill "${skillName}" capabilities.resources must be an object`);
  for (const key of ['maxMemoryMB', 'maxCpuPercent', 'timeoutMs']) {
    if (!Object.prototype.hasOwnProperty.call(res, key)) {
      throw new Error(`Skill "${skillName}" capabilities.resources.${key} is required`);
    }
  }
}

function extractFrontmatterFields(frontmatter: unknown): {
  name?: string;
  description?: string;
  shortDescription?: string;
  keywords?: string[];
  tags?: Record<string, string>;
  traits?: string[];
  allowedTools?: string;
  priority?: number;
} {
  const top = isPlainObject(frontmatter) ? frontmatter : {};
  const metaRaw = top['metadata'];
  const meta = isPlainObject(metaRaw) ? metaRaw : {};

  const nameRaw = top['name'];
  const name = typeof nameRaw === 'string' ? nameRaw : undefined;
  const descriptionRaw = top['description'];
  const description = typeof descriptionRaw === 'string' ? descriptionRaw : undefined;

  const shortDescriptionRaw =
    meta['short-description'] ??
    meta['shortDescription'] ??
    meta['short_description'] ??
    top['shortDescription'] ??
    top['short_description'];
  const shortDescription = typeof shortDescriptionRaw === 'string' ? shortDescriptionRaw : undefined;

  const keywords = parseStringArray(top['keywords'] ?? meta['keywords']);
  const traits = parseStringArray(top['traits'] ?? meta['traits']);
  const tags = parseTags(top['tags'] ?? meta['tags']);

  const allowedToolsRaw =
    top['allowedTools'] ??
    top['allowed_tools'] ??
    top['allowed-tools'] ??
    meta['allowedTools'] ??
    meta['allowed_tools'] ??
    meta['allowed-tools'];
  const allowedTools = typeof allowedToolsRaw === 'string' ? allowedToolsRaw : undefined;

  const priorityRaw = top['priority'] ?? meta['priority'];
  const priority = typeof priorityRaw === 'number' ? priorityRaw : (typeof priorityRaw === 'string' ? Number(priorityRaw) : undefined);

  return { name, description, shortDescription, keywords, tags, traits, allowedTools, priority };
}

function buildKeywordsAll(fields: {
  name: string;
  description: string;
  shortDescription?: string;
  keywords: string[];
  tags?: Record<string, string>;
  traits?: string[];
}): string[] {
  const parts: string[] = [];
  parts.push(fields.name);
  parts.push(fields.description);
  if (fields.shortDescription) parts.push(fields.shortDescription);
  parts.push(...fields.keywords);
  if (fields.traits) parts.push(...fields.traits);
  if (fields.tags) {
    for (const [k, v] of Object.entries(fields.tags)) {
      parts.push(k, v);
    }
  }

  const tokens = parts.flatMap((p) => tokenize(p));
  return uniqueStrings(tokens);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch (_e) {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (_e) {
    return false;
  }
}

async function listDirectories(p: string): Promise<string[]> {
  try {
    const ents = await readdir(p, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_e) {
    return [];
  }
}

async function readTextFile(p: string, maxBytes: number): Promise<string | null> {
  try {
    const st = await stat(p);
    if (st.size > maxBytes) return null;
    const buf = await readFile(p);
    // Skip likely-binary files.
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch (_e) {
    return null;
  }
}

export class SkillLoader {
  private readonly logger?: Logger;
  private readonly maxDepth: number;
  private readonly signatureSecret?: string;
  private readonly enforceSignatures: boolean;
  private readonly loadSupportFiles: boolean;
  private readonly maxSupportFileBytes: number;
  private readonly cache = new Map<string, CachedSkill>();
  private static readonly MAX_CACHE_SIZE = 500;
  private readonly versionTracker?: SkillVersionTracker;
  private readonly diffAnalyzer?: SkillDiffAnalyzer;
  private readonly riskAccumulator?: SkillRiskAccumulator;
  private readonly approver?: SkillModificationApprover;

  constructor(options?: SkillLoaderOptions) {
    this.logger = options?.logger;
    this.maxDepth = options?.maxDepth ?? 5;
    this.signatureSecret = options?.signatureSecret ?? process.env.SKILL_SIGNATURE_SECRET;
    this.enforceSignatures = options?.enforceSignatures ?? Boolean(this.signatureSecret);
    this.loadSupportFiles = options?.loadSupportFiles ?? false;
    this.maxSupportFileBytes = options?.maxSupportFileBytes ?? 256 * 1024;
    this.approver = options?.approver;

    if (options?.enableVersionTracking) {
      this.versionTracker = new SkillVersionTracker({
        storageRoot: options.versionStorageRoot,
        logger: this.logger
      });
      this.diffAnalyzer = new SkillDiffAnalyzer();
      this.riskAccumulator = new SkillRiskAccumulator();
    }
  }

  static computeSignature(frontmatter: unknown, body: string, secret: string): string {
    return computeSkillSignature(frontmatter, body, secret);
  }

  getDefaultRoots(): string[] {
    const cwd = process.cwd();
    const home = os.homedir();
    const candidates = [
      path.resolve(cwd, 'config', 'skills'),
      path.resolve(cwd, 'skills'),
      path.resolve(home, '.codex', 'skills')
    ];
    return candidates;
  }

  async loadAllSkills(roots?: string[]): Promise<Skill[]> {
    const rootsToScan = (roots && roots.length ? roots : this.getDefaultRoots())
      .map((p) => path.resolve(process.cwd(), p))
      .filter((p, idx, arr) => arr.indexOf(p) === idx);

    const skillDirs: string[] = [];
    for (const root of rootsToScan) {
      if (!(await isDirectory(root))) continue;
      const found = await this.findSkillDirs(root);
      skillDirs.push(...found);
    }

    const skills: Skill[] = [];
    for (const dir of skillDirs) {
      const loaded = await this.loadSkillFromDir(dir);
      if (loaded) skills.push(loaded);
    }

    return skills;
  }

  private async findSkillDirs(root: string): Promise<string[]> {
    const out: string[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const { dir, depth } = next;
      if (depth > this.maxDepth) continue;

      const skillMd = path.join(dir, 'SKILL.md');
      if (await fileExists(skillMd)) {
        out.push(dir);
        continue;
      }

      const childDirs = await listDirectories(dir);
      for (const child of childDirs) {
        if (DEFAULT_IGNORED_DIRS.has(child)) continue;
        queue.push({ dir: path.join(dir, child), depth: depth + 1 });
      }
    }

    return out;
  }

  async loadSkillFromDir(skillDir: string): Promise<Skill | null> {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!(await fileExists(skillMdPath))) return null;
    return this.loadSkillFromSkillMd(skillMdPath);
  }

  async loadSkillFromSkillMd(skillMdPath: string): Promise<Skill | null> {
    try {
      const raw = await readFile(skillMdPath, 'utf8');
      const hash = sha256(raw);

      const cached = this.cache.get(skillMdPath);
      if (cached && cached.hash === hash) {
        return cached.skill;
      }

      const { frontmatter, body } = this.parseSkillMarkdown(raw);
      this.verifyFrontmatterSignature(frontmatter, body);
      const extracted = extractFrontmatterFields(frontmatter);
      const name = (extracted.name || path.basename(path.dirname(skillMdPath))).trim();
      const description = (extracted.description || extracted.shortDescription || '').trim();
      if (!name) throw new Error('Skill name is required');
      if (!description) throw new Error(`Skill "${name}" description is required`);

      const cwd = process.cwd();
      const scope = inferScope(skillMdPath, cwd);

      const metadata: SkillMetadata = {
        name,
        description,
        shortDescription: extracted.shortDescription,
        path: path.resolve(skillMdPath),
        scope,
        keywords: uniqueStrings(extracted.keywords || []),
        keywordsAll: buildKeywordsAll({
          name,
          description,
          shortDescription: extracted.shortDescription,
          keywords: extracted.keywords || [],
          tags: extracted.tags,
          traits: extracted.traits
        }),
        allowedTools: extracted.allowedTools,
        tags: extracted.tags,
        traits: extracted.traits?.map((t) => normalizeToken(t)),
        priority: Number.isFinite(extracted.priority) ? Number(extracted.priority) : 0
      };

      const capabilitiesRaw = isPlainObject(frontmatter) ? frontmatter['capabilities'] : undefined;
      if (capabilitiesRaw === undefined) {
        throw new Error(`Skill "${name}" capabilities are required`);
      }
      requireCapabilityKeys(capabilitiesRaw, name);
      const capabilities = mergeWithDefaults(capabilitiesRaw as Partial<SkillCapabilities>);
      validateCapabilities(capabilities);

      const skill: Skill = { metadata, body, capabilities };
      if (this.loadSupportFiles) {
        skill.supportFiles = await this.loadSupportFilesForSkill(path.dirname(skillMdPath));
      }

      if (this.versionTracker && this.diffAnalyzer && this.riskAccumulator) {
        const skillId = name;
        const history = this.versionTracker.getVersionHistory(skillId);
        const previousVersion = history.length > 0 ? history[history.length - 1] : null;

        this.versionTracker.recordVersion(skillId, raw);

        if (previousVersion && previousVersion.content !== raw) {
          const riskFlags = this.diffAnalyzer.analyzeDiff(previousVersion.content, raw);
          if (riskFlags.length > 0) {
            const accumulated = this.riskAccumulator.accumulateRisk(skillId, riskFlags, Date.now());
            const threshold = this.riskAccumulator.checkThreshold(skillId);
            if (threshold.exceedsThreshold) {
              this.logger?.warn?.('Skill version change exceeds risk threshold', {
                skillId,
                reasons: threshold.reasons,
                criticalCount: accumulated.criticalFlags.length,
                highCount: accumulated.highFlags.length,
                escalationCount: accumulated.escalationCount
              });

              if (this.approver) {
                try {
                  await this.approver.createPendingRecord({
                    skillMdPath,
                    skillName: name,
                    detection: {
                      isModified: true,
                      skillMdPath,
                      reason: 'risk_threshold_exceeded',
                      fileHash: sha256(raw),
                      skillName: name
                    }
                  });
                  this.logger?.info?.('Created pending approval record for skill modification', { skillId });
                } catch (error) {
                  this.logger?.error?.('Failed to create pending approval record', {
                    skillId,
                    error: error instanceof Error ? error.message : String(error)
                  });
                }
              }
            }
          }
        }
      }

      // Evict oldest cache entries when exceeding size limit
      if (this.cache.size >= SkillLoader.MAX_CACHE_SIZE && !this.cache.has(skillMdPath)) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(skillMdPath, { hash, skill });
      return skill;
    } catch (error) {
      this.logger?.warn?.('Failed to load skill', {
        path: skillMdPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private parseSkillMarkdown(content: string): { frontmatter: unknown; body: string } {
    if (!content.startsWith('---')) {
      return { frontmatter: {}, body: content.trimStart() };
    }

    const lines = content.split(/\r?\n/);
    if (lines.length < 3) return { frontmatter: {}, body: content.trimStart() };
    if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: content.trimStart() };

    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        end = i;
        break;
      }
    }
    if (end < 0) return { frontmatter: {}, body: content.trimStart() };

    const yamlText = lines.slice(1, end).join('\n');
    const rest = lines.slice(end + 1).join('\n');
    const frontmatter = yamlText.trim().length ? (parseYaml(yamlText) as unknown) : {};
    return { frontmatter, body: rest.trimStart() };
  }

  private verifyFrontmatterSignature(frontmatter: unknown, body: string): void {
    const signatureRaw = isPlainObject(frontmatter) ? frontmatter['signature'] : undefined;
    if (signatureRaw !== undefined && signatureRaw !== null && typeof signatureRaw !== 'string') {
      throw new Error('Skill signature must be a string');
    }
    const hasSignature = typeof signatureRaw === 'string' && signatureRaw.trim().length > 0;

    if (!hasSignature) {
      if (this.enforceSignatures) {
        throw new Error('Skill signature is required');
      }
      return;
    }

    if (!this.signatureSecret) {
      throw new Error('Skill signature provided but SKILL_SIGNATURE_SECRET is not configured');
    }

    const provided = normalizeHexSignature(signatureRaw);
    const expected = computeSkillSignature(frontmatter, body, this.signatureSecret);
    if (!safeHexEqual(expected, provided)) {
      throw new Error('Skill signature mismatch');
    }
  }

  private async loadSupportFilesForSkill(skillDir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const dirs = ['scripts', 'references'];

    for (const sub of dirs) {
      const root = path.join(skillDir, sub);
      if (!(await isDirectory(root))) continue;
      await this.walkSupportDir(root, (absPath, relPath) => {
        // Use forward slashes for stable keys.
        const key = `${sub}/${relPath.split(path.sep).join('/')}`;
        return this.addSupportFile(out, absPath, key);
      });
    }

    return out;
  }

  private async addSupportFile(map: Map<string, string>, absPath: string, key: string): Promise<void> {
    const text = await readTextFile(absPath, this.maxSupportFileBytes);
    if (text === null) return;
    map.set(key, text);
  }

  private async walkSupportDir(root: string, onFile: (absPath: string, relPath: string) => Promise<void>): Promise<void> {
    const queue: string[] = [root];
    while (queue.length) {
      const dir = queue.shift();
      if (!dir) break;
      let ents: Array<{ name: string; isDirectory: boolean; isFile: boolean }> = [];
      try {
        const raw = await readdir(dir, { withFileTypes: true });
        ents = raw.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
      } catch (e) {
        this.logger?.warn?.('Failed to read directory during skill scan', { dir, error: (e as Error)?.message || String(e) });
        continue;
      }

      for (const ent of ents) {
        if (DEFAULT_IGNORED_DIRS.has(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory) {
          queue.push(abs);
          continue;
        }
        if (!ent.isFile) continue;
        const rel = path.relative(root, abs);
        await onFile(abs, rel);
      }
    }
  }
}
