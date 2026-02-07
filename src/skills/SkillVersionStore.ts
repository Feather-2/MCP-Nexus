import path from 'path';
import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type { Logger } from '../types/index.js';

const VERSIONS_DIR = 'skills-versions';
const DEFAULT_MAX_SNAPSHOTS = 10;
const MAX_FILE_BYTES = 100 * 1024;

export interface SkillSnapshot {
  id: string;
  timestamp: number;
  files: Record<string, string>;
  reason?: string;
}

interface SkillVersionDocument {
  current: string;
  snapshots: SkillSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneFiles(files: Record<string, string>): Record<string, string> {
  return { ...files };
}

function parseSnapshot(value: unknown): SkillSnapshot | null {
  if (!isRecord(value)) return null;

  const id = value.id;
  const timestamp = value.timestamp;
  const files = value.files;
  const reason = value.reason;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  if (!isRecord(files)) return null;

  const normalizedFiles: Record<string, string> = {};
  for (const [filePath, fileContent] of Object.entries(files)) {
    if (typeof filePath !== 'string' || filePath.length === 0) continue;
    if (typeof fileContent !== 'string') continue;
    normalizedFiles[filePath] = fileContent;
  }

  const snapshot: SkillSnapshot = {
    id,
    timestamp,
    files: normalizedFiles
  };

  if (typeof reason === 'string' && reason.length > 0) {
    snapshot.reason = reason;
  }

  return snapshot;
}

function normalizeSkillName(skillName: string): string {
  const normalized = skillName.trim();
  if (!normalized) {
    throw new Error('Skill name is required');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
  return normalized;
}

function buildEmptyDocument(): SkillVersionDocument {
  return { current: '', snapshots: [] };
}

export interface SkillVersionStoreOptions {
  storageRoot: string;
  logger?: Logger;
  maxSnapshots?: number;
}

export class SkillVersionStore {
  private readonly storageRoot: string;
  private readonly logger?: Logger;
  private readonly maxSnapshots: number;

  constructor(options: SkillVersionStoreOptions) {
    this.storageRoot = path.resolve(options.storageRoot);
    this.logger = options.logger;
    const configuredMax = Number(options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
    this.maxSnapshots = Number.isInteger(configuredMax) && configuredMax > 0
      ? configuredMax
      : DEFAULT_MAX_SNAPSHOTS;
  }

  async save(skillName: string, files: Record<string, string>, reason?: string): Promise<SkillSnapshot> {
    const normalizedName = normalizeSkillName(skillName);
    const document = await this.readDocument(normalizedName);

    const snapshot: SkillSnapshot = {
      id: this.createSnapshotId(),
      timestamp: Date.now(),
      files: this.filterFiles(files),
      reason: reason?.trim() || undefined
    };

    document.snapshots.push(snapshot);
    document.current = snapshot.id;
    this.trimSnapshots(document);

    await this.writeDocument(normalizedName, document);

    this.logger?.debug('Skill snapshot saved', {
      skillName: normalizedName,
      snapshotId: snapshot.id,
      files: Object.keys(snapshot.files).length,
      totalSnapshots: document.snapshots.length
    });

    return snapshot;
  }

  async list(skillName: string): Promise<SkillSnapshot[]> {
    const normalizedName = normalizeSkillName(skillName);
    const document = await this.readDocument(normalizedName);
    return [...document.snapshots].sort((left, right) => right.timestamp - left.timestamp);
  }

  async rollback(skillName: string, snapshotId: string): Promise<SkillSnapshot | null> {
    const normalizedName = normalizeSkillName(skillName);
    const normalizedSnapshotId = String(snapshotId || '').trim();
    if (!normalizedSnapshotId) return null;

    const document = await this.readDocument(normalizedName);
    const target = document.snapshots.find((snapshot) => snapshot.id === normalizedSnapshotId);
    if (!target) {
      return null;
    }

    const current = this.resolveCurrentSnapshot(document);
    if (current) {
      const backup: SkillSnapshot = {
        id: this.createSnapshotId(),
        timestamp: Date.now(),
        files: cloneFiles(current.files),
        reason: 'rollback'
      };
      document.snapshots.push(backup);
    }

    this.trimSnapshots(document, target.id);
    document.current = target.id;
    await this.writeDocument(normalizedName, document);

    this.logger?.info('Skill snapshot rolled back', {
      skillName: normalizedName,
      snapshotId: target.id,
      backupCreated: Boolean(current)
    });

    return target;
  }

  async get(skillName: string, snapshotId: string): Promise<SkillSnapshot | null> {
    const normalizedName = normalizeSkillName(skillName);
    const normalizedSnapshotId = String(snapshotId || '').trim();
    if (!normalizedSnapshotId) return null;

    const document = await this.readDocument(normalizedName);
    return document.snapshots.find((snapshot) => snapshot.id === normalizedSnapshotId) ?? null;
  }

  private createSnapshotId(): string {
    return randomBytes(4).toString('hex');
  }

  private filterFiles(files: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const [filePath, fileContent] of Object.entries(files || {})) {
      if (!filePath) continue;
      if (typeof fileContent !== 'string') continue;

      const byteLength = Buffer.byteLength(fileContent, 'utf8');
      if (byteLength >= MAX_FILE_BYTES) {
        this.logger?.debug('Skip oversized file in skill snapshot', {
          filePath,
          size: byteLength,
          maxSize: MAX_FILE_BYTES
        });
        continue;
      }

      filtered[filePath] = fileContent;
    }

    return filtered;
  }

  private resolveCurrentSnapshot(document: SkillVersionDocument): SkillSnapshot | undefined {
    if (document.current) {
      const found = document.snapshots.find((snapshot) => snapshot.id === document.current);
      if (found) return found;
    }
    return document.snapshots[document.snapshots.length - 1];
  }

  private trimSnapshots(document: SkillVersionDocument, preserveSnapshotId?: string): void {
    while (document.snapshots.length > this.maxSnapshots) {
      const removableIndex = preserveSnapshotId
        ? document.snapshots.findIndex((snapshot) => snapshot.id !== preserveSnapshotId)
        : 0;

      if (removableIndex < 0) break;
      document.snapshots.splice(removableIndex, 1);
    }

    if (document.current && !document.snapshots.some((snapshot) => snapshot.id === document.current)) {
      document.current = document.snapshots[document.snapshots.length - 1]?.id || '';
    }
  }

  private getDocumentPath(skillName: string): string {
    return path.join(this.storageRoot, VERSIONS_DIR, `${skillName}.json`);
  }

  private async readDocument(skillName: string): Promise<SkillVersionDocument> {
    const documentPath = this.getDocumentPath(skillName);

    try {
      const raw = await readFile(documentPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        return buildEmptyDocument();
      }

      const rawSnapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
      const snapshots = rawSnapshots
        .map((entry) => parseSnapshot(entry))
        .filter((entry): entry is SkillSnapshot => Boolean(entry));
      const current = typeof parsed.current === 'string' ? parsed.current : '';

      const document: SkillVersionDocument = {
        current,
        snapshots
      };

      if (document.current && !document.snapshots.some((snapshot) => snapshot.id === document.current)) {
        document.current = document.snapshots[document.snapshots.length - 1]?.id || '';
      }

      return document;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        return buildEmptyDocument();
      }
      throw new Error(`Failed to read skill version document: ${skillName}`, { cause: error });
    }
  }

  private async writeDocument(skillName: string, document: SkillVersionDocument): Promise<void> {
    const documentPath = this.getDocumentPath(skillName);

    try {
      await mkdir(path.dirname(documentPath), { recursive: true });
      await writeFile(documentPath, JSON.stringify(document, null, 2), 'utf8');
    } catch (error) {
      throw new Error(`Failed to write skill version document: ${skillName}`, { cause: error });
    }
  }
}
