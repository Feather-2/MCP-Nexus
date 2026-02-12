import crypto from 'crypto';
import path from 'path';
import { appendFile, mkdir, readFile } from 'fs/promises';
import type { Logger } from '../types/index.js';

const GENESIS_HASH = '0'.repeat(64);

export interface AuditLogInput {
  timestamp?: string;
  action: string;
  skillId: string;
  userId: string;
  result: string;
}

export interface AuditLogEntry {
  timestamp: string;
  action: string;
  skillId: string;
  userId: string;
  result: string;
  prevHash: string;
  hash: string;
}

export interface AuditLoggerOptions {
  filePath: string;
  logger?: Logger;
}

function normalizeRequired(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`Audit log ${field} is required`);
  return normalized;
}

function computeHash(input: Omit<AuditLogEntry, 'hash'>): string {
  const payload = JSON.stringify({
    timestamp: input.timestamp,
    action: input.action,
    skillId: input.skillId,
    userId: input.userId,
    result: input.result,
    prevHash: input.prevHash
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function parseEntry(line: string): AuditLogEntry | null {
  if (!line.trim()) return null;
  const parsed = JSON.parse(line) as Partial<AuditLogEntry>;
  if (
    typeof parsed.timestamp !== 'string' ||
    typeof parsed.action !== 'string' ||
    typeof parsed.skillId !== 'string' ||
    typeof parsed.userId !== 'string' ||
    typeof parsed.result !== 'string' ||
    typeof parsed.prevHash !== 'string' ||
    typeof parsed.hash !== 'string'
  ) {
    throw new Error('Invalid audit log entry format');
  }
  return parsed as AuditLogEntry;
}

export class AuditLogger {
  private readonly filePath: string;
  private readonly logger?: Logger;
  private lastHash?: string;

  constructor(options: AuditLoggerOptions) {
    this.filePath = path.resolve(options.filePath);
    this.logger = options.logger;
  }

  async append(entry: AuditLogInput): Promise<AuditLogEntry> {
    const prevHash = await this.getLastHash();
    const next: Omit<AuditLogEntry, 'hash'> = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      action: normalizeRequired(entry.action, 'action'),
      skillId: normalizeRequired(entry.skillId, 'skillId'),
      userId: normalizeRequired(entry.userId, 'userId'),
      result: normalizeRequired(entry.result, 'result'),
      prevHash
    };
    const hash = computeHash(next);
    const persisted: AuditLogEntry = { ...next, hash };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(persisted)}\n`, 'utf8');
    this.lastHash = hash;

    this.logger?.info('Audit log entry appended', {
      action: persisted.action,
      skillId: persisted.skillId,
      userId: persisted.userId,
      hash: persisted.hash
    });

    return persisted;
  }

  async verifyChain(): Promise<boolean> {
    const lines = await this.readLines();
    let prevHash = GENESIS_HASH;

    for (const line of lines) {
      const entry = parseEntry(line);
      if (!entry) continue;
      if (entry.prevHash !== prevHash) return false;
      const expected = computeHash({
        timestamp: entry.timestamp,
        action: entry.action,
        skillId: entry.skillId,
        userId: entry.userId,
        result: entry.result,
        prevHash: entry.prevHash
      });
      if (expected !== entry.hash) return false;
      prevHash = entry.hash;
    }

    this.lastHash = prevHash;
    return true;
  }

  private async getLastHash(): Promise<string> {
    if (this.lastHash) return this.lastHash;

    const lines = await this.readLines();
    if (lines.length === 0) {
      this.lastHash = GENESIS_HASH;
      return this.lastHash;
    }

    const lastEntry = parseEntry(lines[lines.length - 1] || '');
    this.lastHash = lastEntry?.hash || GENESIS_HASH;
    return this.lastHash;
  }

  private async readLines(): Promise<string[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') return [];
      throw new Error('Failed to read audit log file', { cause: error });
    }
  }
}
