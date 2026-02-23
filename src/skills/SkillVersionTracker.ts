import crypto from 'crypto';
import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type { Logger } from '../types/index.js';

const VERSION_DIR_NAME = path.join('data', 'skill-versions');

export interface VersionEntry {
  hash: string;
  timestamp: number;
  content: string;
  metadata: {
    modifiedBy?: string;
    reason?: string;
  };
}

interface VersionHistoryDocument {
  skillId: string;
  versions: VersionEntry[];
}

export interface SkillVersionTrackerOptions {
  storageRoot?: string;
  logger?: Logger;
  nowProvider?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSkillId(skillId: string): string {
  const normalized = String(skillId || '').trim();
  if (!normalized) {
    throw new Error('Skill id is required');
  }
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  return normalized;
}

function normalizeMetadata(value: unknown): VersionEntry['metadata'] {
  if (!isRecord(value)) {
    return {};
  }

  const metadata: VersionEntry['metadata'] = {};
  if (typeof value.modifiedBy === 'string' && value.modifiedBy.trim()) {
    metadata.modifiedBy = value.modifiedBy.trim();
  }
  if (typeof value.reason === 'string' && value.reason.trim()) {
    metadata.reason = value.reason.trim();
  }
  return metadata;
}

function cloneVersion(entry: VersionEntry): VersionEntry {
  return {
    hash: entry.hash,
    timestamp: entry.timestamp,
    content: entry.content,
    metadata: { ...entry.metadata }
  };
}

function parseVersionEntry(value: unknown): VersionEntry | null {
  if (!isRecord(value)) return null;

  const hash = value.hash;
  const timestamp = value.timestamp;
  const content = value.content;

  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  if (typeof content !== 'string') return null;

  return {
    hash: hash.toLowerCase(),
    timestamp,
    content,
    metadata: normalizeMetadata(value.metadata)
  };
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class SkillVersionTracker {
  private readonly storageRoot: string;
  private readonly logger?: Logger;
  private readonly nowProvider: () => number;

  constructor(options: SkillVersionTrackerOptions = {}) {
    this.storageRoot = path.resolve(options.storageRoot ?? process.cwd());
    this.logger = options.logger;
    this.nowProvider = options.nowProvider ?? Date.now;
  }

  async recordVersion(skillId: string, content: string, metadata: object = {}): Promise<string> {
    const normalizedSkillId = normalizeSkillId(skillId);
    const normalizedContent = String(content ?? '');
    const history = await this.readHistory(normalizedSkillId);
    const hash = sha256(normalizedContent);

    history.versions.push({
      hash,
      timestamp: this.nowProvider(),
      content: normalizedContent,
      metadata: normalizeMetadata(metadata)
    });
    // Cap version history to prevent unbounded growth
    if (history.versions.length > 50) {
      history.versions.splice(0, history.versions.length - 50);
    }

    await this.writeHistory(normalizedSkillId, history);
    this.logger?.debug('Skill version recorded', {
      skillId: normalizedSkillId,
      hash,
      totalVersions: history.versions.length
    });

    return hash;
  }

  async getVersionHistory(skillId: string): Promise<VersionEntry[]> {
    const normalizedSkillId = normalizeSkillId(skillId);
    const history = await this.readHistory(normalizedSkillId);
    return history.versions.map((entry) => cloneVersion(entry));
  }

  async getVersion(skillId: string, versionHash: string): Promise<VersionEntry | null> {
    const normalizedSkillId = normalizeSkillId(skillId);
    const normalizedHash = String(versionHash || '').trim().toLowerCase();
    if (!normalizedHash) {
      return null;
    }

    const history = await this.readHistory(normalizedSkillId);
    for (let index = history.versions.length - 1; index >= 0; index -= 1) {
      const entry = history.versions[index];
      if (entry?.hash === normalizedHash) {
        return cloneVersion(entry);
      }
    }

    return null;
  }

  private getSkillFilePath(skillId: string): string {
    return path.join(this.storageRoot, VERSION_DIR_NAME, `${skillId}.json`);
  }

  private async readHistory(skillId: string): Promise<VersionHistoryDocument> {
    const filePath = this.getSkillFilePath(skillId);

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const versionsRaw = Array.isArray(parsed)
        ? parsed
        : (isRecord(parsed) && Array.isArray(parsed.versions) ? parsed.versions : []);
      const versions = versionsRaw
        .map((entry) => parseVersionEntry(entry))
        .filter((entry): entry is VersionEntry => Boolean(entry));

      return {
        skillId,
        versions
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        return {
          skillId,
          versions: []
        };
      }
      throw new Error(`Failed to read skill version history: ${skillId}`, { cause: error });
    }
  }

  private async writeHistory(skillId: string, history: VersionHistoryDocument): Promise<void> {
    const filePath = this.getSkillFilePath(skillId);

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify({
        skillId,
        versions: history.versions
      }, null, 2), 'utf8');
    } catch (error) {
      throw new Error(`Failed to write skill version history: ${skillId}`, { cause: error });
    }
  }
}
