import crypto from 'crypto';
import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type { Logger } from '../types/index.js';
import type { AuditLogger } from '../security/AuditLogger.js';
import type {
  SkillContentDiff,
  SkillModificationDetectionResult,
  SkillModificationSummary
} from './SkillModificationDetector.js';

export type SkillModificationApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface SkillModificationPendingInput {
  skillMdPath: string;
  skillName: string;
  detection: SkillModificationDetectionResult;
}

export interface SkillModificationRecord {
  id: string;
  skillMdPath: string;
  skillName: string;
  status: SkillModificationApprovalStatus;
  createdAt: string;
  updatedAt: string;
  detectionReason: string;
  fileHash?: string;
  diff?: SkillContentDiff;
  summary?: SkillModificationSummary;
  decisionBy?: string;
  decisionReason?: string;
  signature?: string;
}

interface SkillModificationStoreDocument {
  records: SkillModificationRecord[];
}

export interface SkillResignerLike {
  resign: (skillMdPath: string) => Promise<{ signature: string }>;
}

export interface SkillModificationApproverOptions {
  storeFilePath: string;
  auditLogger: AuditLogger;
  resigner: SkillResignerLike;
  logger?: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSkillName(input: string): string {
  const normalized = String(input || '').trim();
  if (normalized.length > 0) return normalized;
  return 'unknown-skill';
}

function toRecord(value: unknown): SkillModificationRecord | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const skillMdPath = value['skillMdPath'];
  const skillName = value['skillName'];
  const status = value['status'];
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  const detectionReason = value['detectionReason'];

  if (
    typeof id !== 'string' ||
    typeof skillMdPath !== 'string' ||
    typeof skillName !== 'string' ||
    typeof status !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    typeof detectionReason !== 'string'
  ) {
    return null;
  }

  if (status !== 'pending' && status !== 'approved' && status !== 'rejected') {
    return null;
  }

  const out: SkillModificationRecord = {
    id,
    skillMdPath,
    skillName,
    status,
    createdAt,
    updatedAt,
    detectionReason
  };

  if (typeof value['fileHash'] === 'string') out.fileHash = value['fileHash'];
  if (typeof value['decisionBy'] === 'string') out.decisionBy = value['decisionBy'];
  if (typeof value['decisionReason'] === 'string') out.decisionReason = value['decisionReason'];
  if (typeof value['signature'] === 'string') out.signature = value['signature'];

  const diff = value['diff'];
  if (diff && typeof diff === 'object') out.diff = diff as SkillContentDiff;
  const summary = value['summary'];
  if (summary && typeof summary === 'object') out.summary = summary as SkillModificationSummary;

  return out;
}

export class SkillModificationApprover {
  private readonly storeFilePath: string;
  private readonly logger?: Logger;
  private readonly auditLogger: AuditLogger;
  private readonly resigner: SkillResignerLike;

  constructor(options: SkillModificationApproverOptions) {
    this.storeFilePath = path.resolve(options.storeFilePath);
    this.auditLogger = options.auditLogger;
    this.resigner = options.resigner;
    this.logger = options.logger;
  }

  async createPendingRecord(input: SkillModificationPendingInput): Promise<SkillModificationRecord> {
    const doc = await this.readStore();
    const skillMdPath = path.resolve(input.skillMdPath);
    const fileHash = input.detection.fileHash;

    const existing = doc.records.find((record) => (
      record.status === 'pending' &&
      record.skillMdPath === skillMdPath &&
      record.fileHash === fileHash
    ));
    if (existing) return existing;

    const now = new Date().toISOString();
    const next: SkillModificationRecord = {
      id: crypto.randomBytes(8).toString('hex'),
      skillMdPath,
      skillName: normalizeSkillName(input.skillName || input.detection.skillName || ''),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      detectionReason: input.detection.reason,
      fileHash,
      diff: input.detection.diff,
      summary: input.detection.summary
    };

    doc.records.push(next);
    await this.writeStore(doc);
    return next;
  }

  async list(status?: SkillModificationApprovalStatus): Promise<SkillModificationRecord[]> {
    const doc = await this.readStore();
    const records = status
      ? doc.records.filter((record) => record.status === status)
      : doc.records;
    return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private storeLock = Promise.resolve();

  async approve(recordId: string, userId: string, reason?: string): Promise<SkillModificationRecord | null> {
    const prev = this.storeLock;
    let release!: () => void;
    this.storeLock = new Promise<void>(r => { release = r; });
    await prev;
    try {
    const doc = await this.readStore();
    const record = doc.records.find((item) => item.id === recordId);
    if (!record) return null;
    if (record.status !== 'pending') return record;

    const resignResult = await this.resigner.resign(record.skillMdPath);
    record.status = 'approved';
    record.updatedAt = new Date().toISOString();
    record.decisionBy = String(userId || '').trim() || 'system';
    record.decisionReason = reason?.trim() || undefined;
    record.signature = resignResult.signature;

    await this.writeStore(doc);
    await this.auditLogger.append({
      action: 'skill_modification_approved',
      skillId: record.skillName,
      userId: record.decisionBy,
      result: record.decisionReason ? `approved:${record.decisionReason}` : 'approved'
    });

    this.logger?.info?.('Skill modification approved', {
      id: record.id,
      skill: record.skillName,
      userId: record.decisionBy
    });
    return record;
    } finally {
      release();
    }
  }

  async reject(recordId: string, userId: string, reason?: string): Promise<SkillModificationRecord | null> {
    const prev2 = this.storeLock;
    let release2!: () => void;
    this.storeLock = new Promise<void>(r => { release2 = r; });
    await prev2;
    try {
    const doc = await this.readStore();
    const record = doc.records.find((item) => item.id === recordId);
    if (!record) return null;
    if (record.status !== 'pending') return record;

    record.status = 'rejected';
    record.updatedAt = new Date().toISOString();
    record.decisionBy = String(userId || '').trim() || 'system';
    record.decisionReason = reason?.trim() || undefined;

    await this.writeStore(doc);
    await this.auditLogger.append({
      action: 'skill_modification_rejected',
      skillId: record.skillName,
      userId: record.decisionBy,
      result: record.decisionReason ? `rejected:${record.decisionReason}` : 'rejected'
    });

    this.logger?.info?.('Skill modification rejected', {
      id: record.id,
      skill: record.skillName,
      userId: record.decisionBy
    });
    return record;
    } finally {
      release2();
    }
  }

  private async readStore(): Promise<SkillModificationStoreDocument> {
    try {
      const raw = await readFile(this.storeFilePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const records = isRecord(parsed) && Array.isArray(parsed['records'])
        ? parsed['records'].map((entry) => toRecord(entry)).filter((entry): entry is SkillModificationRecord => Boolean(entry))
        : [];
      return { records };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') return { records: [] };
      throw new Error('Failed to read skill modification store', { cause: error });
    }
  }

  private async writeStore(document: SkillModificationStoreDocument): Promise<void> {
    try {
      await mkdir(path.dirname(this.storeFilePath), { recursive: true });
      await writeFile(this.storeFilePath, JSON.stringify(document, null, 2), 'utf8');
    } catch (error) {
      throw new Error('Failed to write skill modification store', { cause: error });
    }
  }
}
