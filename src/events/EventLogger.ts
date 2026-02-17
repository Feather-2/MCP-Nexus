import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Event, EventType } from './types.js';
import { DEFAULT_EVENT_VERSION } from './types.js';

const require = createRequire(import.meta.url);

interface SqliteDb {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): SqliteStatement;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

type BetterSqliteCtor = new (path: string) => SqliteDb;

let BetterSqlite: BetterSqliteCtor | null = null;
try {
  BetterSqlite = require('better-sqlite3') as BetterSqliteCtor;
} catch {
  BetterSqlite = null;
}

const SQLITE_AVAILABLE = Boolean(BetterSqlite);
const DEFAULT_DB_PATH = 'data/event-log.db';
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;

type EventLogRow = {
  id: string;
  type: string;
  version: string;
  timestamp: number;
  session_id: string | null;
  payload_json: string;
  created_at: number;
};

type StatsRow = {
  total: number;
  latest_timestamp: number | null;
};

type GroupCountRow = {
  key: string;
  count: number;
};

function normalizeVersion(version: string | undefined): string {
  if (!version) return DEFAULT_EVENT_VERSION;
  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_EVENT_VERSION;
}

function normalizeDateToEpochMs(value: Date | undefined, fallbackMs: number): number {
  if (!(value instanceof Date)) return fallbackMs;
  const epochMs = value.getTime();
  return Number.isFinite(epochMs) ? epochMs : fallbackMs;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  const normalized = Math.trunc(limit);
  if (normalized < 1) return 1;
  if (normalized > MAX_QUERY_LIMIT) return MAX_QUERY_LIMIT;
  return normalized;
}

function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

function serializePayload(payload: unknown): string {
  if (payload === undefined) return '';

  try {
    const payloadJson = JSON.stringify(payload);
    return payloadJson ?? '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ serializationError: message });
  }
}

function deserializePayload(payloadJson: string): unknown {
  if (payloadJson.length === 0) return undefined;

  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}

function toCountMap(rows: GroupCountRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (!row.key) continue;
    out[row.key] = row.count;
  }
  return out;
}

export interface EventLoggerOptions {
  dbPath?: string;
}

export interface EventLogQueryFilters {
  id?: string;
  type?: EventType;
  version?: string;
  sessionId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface LoggedEvent extends Event {
  id: string;
  type: EventType;
  version: string;
  timestamp: Date;
  createdAt: Date;
}

export interface EventLogStats {
  enabled: boolean;
  total: number;
  byType: Record<string, number>;
  byVersion: Record<string, number>;
  latestTimestamp?: Date;
}

export class EventLogger {
  static get sqliteAvailable(): boolean {
    return SQLITE_AVAILABLE;
  }

  private readonly db: SqliteDb | null;
  private readonly stmtInsert: SqliteStatement | null;
  private readonly stmtStats: SqliteStatement | null;
  private readonly stmtStatsByType: SqliteStatement | null;
  private readonly stmtStatsByVersion: SqliteStatement | null;

  constructor(options?: EventLoggerOptions) {
    const dbPath = options?.dbPath ?? DEFAULT_DB_PATH;

    let db: SqliteDb | null = null;
    let stmtInsert: SqliteStatement | null = null;
    let stmtStats: SqliteStatement | null = null;
    let stmtStatsByType: SqliteStatement | null = null;
    let stmtStatsByVersion: SqliteStatement | null = null;

    if (SQLITE_AVAILABLE && BetterSqlite) {
      try {
        if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
        db = new BetterSqlite(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec(`
          CREATE TABLE IF NOT EXISTS event_log (
            id TEXT NOT NULL,
            type TEXT NOT NULL,
            version TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            session_id TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type);
          CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
          CREATE INDEX IF NOT EXISTS idx_event_log_session_id ON event_log(session_id);
        `);

        stmtInsert = db.prepare(`
          INSERT INTO event_log
            (id, type, version, timestamp, session_id, payload_json, created_at)
          VALUES
            (@id, @type, @version, @timestamp, @session_id, @payload_json, @created_at)
        `);
        stmtStats = db.prepare(`
          SELECT
            COUNT(*) AS total,
            MAX(timestamp) AS latest_timestamp
          FROM event_log
        `);
        stmtStatsByType = db.prepare(`
          SELECT type AS key, COUNT(*) AS count
          FROM event_log
          GROUP BY type
        `);
        stmtStatsByVersion = db.prepare(`
          SELECT version AS key, COUNT(*) AS count
          FROM event_log
          GROUP BY version
        `);
      } catch {
        db?.close?.();
        db = null;
        stmtInsert = null;
        stmtStats = null;
        stmtStatsByType = null;
        stmtStatsByVersion = null;
      }
    }

    this.db = db;
    this.stmtInsert = stmtInsert;
    this.stmtStats = stmtStats;
    this.stmtStatsByType = stmtStatsByType;
    this.stmtStatsByVersion = stmtStatsByVersion;
  }

  isEnabled(): boolean {
    return Boolean(this.db);
  }

  private enrichPayload(event: Event): unknown {
    const base = (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
      ? { ...(event.payload as Record<string, unknown>) }
      : { _payload: event.payload } as Record<string, unknown>;
    if (event.runId) base.runId = event.runId;
    if (event.stage) base.stage = event.stage;
    if (event.component) base.component = event.component;
    if (event.metadata) base.metadata = event.metadata;
    return base;
  }

  log(event: Event): boolean {
    if (!this.stmtInsert) return false;
    if (!event?.type) return false;

    const nowMs = Date.now();
    const row = {
      id: event.id && event.id.length > 0 ? event.id : randomUUID(),
      type: event.type,
      version: normalizeVersion(event.version),
      timestamp: normalizeDateToEpochMs(event.timestamp, nowMs),
      session_id: event.sessionId ?? null,
      payload_json: serializePayload(this.enrichPayload(event)),
      created_at: nowMs
    };

    try {
      this.stmtInsert.run(row);
      return true;
    } catch {
      return false;
    }
  }

  query(filters?: EventLogQueryFilters): LoggedEvent[] {
    if (!this.db) return [];

    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (filters?.id) {
      whereParts.push('id = ?');
      params.push(filters.id);
    }
    if (filters?.type) {
      whereParts.push('type = ?');
      params.push(filters.type);
    }
    if (filters?.version) {
      whereParts.push('version = ?');
      params.push(filters.version);
    }
    if (filters?.sessionId) {
      whereParts.push('session_id = ?');
      params.push(filters.sessionId);
    }
    if (filters?.from instanceof Date) {
      whereParts.push('timestamp >= ?');
      params.push(filters.from.getTime());
    }
    if (filters?.to instanceof Date) {
      whereParts.push('timestamp <= ?');
      params.push(filters.to.getTime());
    }

    let sql = `
      SELECT
        id,
        type,
        version,
        timestamp,
        session_id,
        payload_json,
        created_at
      FROM event_log
    `;

    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(' AND ')}`;
    }

    sql += ' ORDER BY timestamp DESC, created_at DESC';

    const limit = normalizeLimit(filters?.limit);
    const offset = normalizeOffset(filters?.offset);
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventLogRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      version: normalizeVersion(row.version),
      timestamp: new Date(row.timestamp),
      sessionId: row.session_id ?? undefined,
      payload: deserializePayload(row.payload_json),
      createdAt: new Date(row.created_at)
    }));
  }

  stats(): EventLogStats {
    if (!this.stmtStats || !this.stmtStatsByType || !this.stmtStatsByVersion) {
      return {
        enabled: false,
        total: 0,
        byType: {},
        byVersion: {}
      };
    }

    const totals = this.stmtStats.get() as StatsRow | undefined;
    const byTypeRows = this.stmtStatsByType.all() as GroupCountRow[];
    const byVersionRows = this.stmtStatsByVersion.all() as GroupCountRow[];

    return {
      enabled: true,
      total: totals?.total ?? 0,
      byType: toCountMap(byTypeRows),
      byVersion: toCountMap(byVersionRows),
      latestTimestamp:
        typeof totals?.latest_timestamp === 'number' ? new Date(totals.latest_timestamp) : undefined
    };
  }

  close(): void {
    this.db?.close?.();
  }
}
