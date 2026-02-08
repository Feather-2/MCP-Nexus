import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type { SkillCapabilities } from '../security/CapabilityManifest.js';
import type { Logger } from '../types/index.js';

const AUTHORIZATION_FILE_NAME = 'skill-authorizations.json';

export interface AuthorizationState {
  enabled: boolean;
  authorizedCapabilities: Partial<SkillCapabilities> | null; // null = 全部授权, Partial = 逐项授权
  authorizedAt?: number; // timestamp
  authorizedBy?: string; // userId
}

export interface AuthorizationStore {
  // key: skillName (lowercase)
  [skillName: string]: AuthorizationState;
}

export interface SkillAuthorizationOptions {
  storageRoot: string;
  logger?: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildDefaultState(): AuthorizationState {
  return {
    enabled: false,
    authorizedCapabilities: null
  };
}

function normalizeSkillName(skillName: string): string {
  const normalized = String(skillName || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Skill name is required');
  }
  return normalized;
}

function cloneCapabilities(capabilities: Partial<SkillCapabilities> | null): Partial<SkillCapabilities> | null {
  if (capabilities === null) {
    return null;
  }
  return structuredClone(capabilities);
}

function cloneState(state: AuthorizationState): AuthorizationState {
  return {
    enabled: state.enabled,
    authorizedCapabilities: cloneCapabilities(state.authorizedCapabilities),
    authorizedAt: state.authorizedAt,
    authorizedBy: state.authorizedBy
  };
}

function parseState(value: unknown): AuthorizationState | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    return null;
  }

  const rawCapabilities = value.authorizedCapabilities;
  if (rawCapabilities !== undefined && rawCapabilities !== null && !isRecord(rawCapabilities)) {
    return null;
  }

  const state: AuthorizationState = {
    enabled: value.enabled,
    authorizedCapabilities: rawCapabilities === undefined || rawCapabilities === null
      ? null
      : cloneCapabilities(rawCapabilities as Partial<SkillCapabilities>)
  };

  if (typeof value.authorizedAt === 'number' && Number.isFinite(value.authorizedAt)) {
    state.authorizedAt = value.authorizedAt;
  }

  if (typeof value.authorizedBy === 'string' && value.authorizedBy.trim().length > 0) {
    state.authorizedBy = value.authorizedBy.trim();
  }

  return state;
}

export class SkillAuthorization {
  private readonly logger?: Logger;
  private readonly storagePath: string;
  private cache: AuthorizationStore | null = null;
  private cacheLoadedAt = 0;
  private readonly cacheTtlMs = 5000;

  constructor(options: SkillAuthorizationOptions) {
    this.logger = options.logger;
    this.storagePath = path.join(path.resolve(options.storageRoot), AUTHORIZATION_FILE_NAME);
  }

  async getState(skillName: string): Promise<AuthorizationState> {
    const normalizedName = normalizeSkillName(skillName);
    const store = await this.getCachedStore();
    const state = store[normalizedName];
    return state ? cloneState(state) : buildDefaultState();
  }

  async authorize(
    skillName: string,
    options?: { capabilities?: Partial<SkillCapabilities>; userId?: string }
  ): Promise<AuthorizationState> {
    const normalizedName = normalizeSkillName(skillName);
    const store = await this.readStore();

    const nextState: AuthorizationState = {
      enabled: true,
      authorizedCapabilities: options?.capabilities === undefined
        ? null
        : cloneCapabilities(options.capabilities),
      authorizedAt: Date.now()
    };

    const userId = options?.userId?.trim();
    if (userId) {
      nextState.authorizedBy = userId;
    }

    store[normalizedName] = nextState;
    await this.writeStore(store);
    this.cache = store;
    this.cacheLoadedAt = Date.now();

    this.logger?.info('Skill authorized', {
      skillName: normalizedName,
      mode: nextState.authorizedCapabilities === null ? 'all' : 'partial',
      userId: nextState.authorizedBy
    });

    return cloneState(nextState);
  }

  async revoke(skillName: string): Promise<AuthorizationState> {
    const normalizedName = normalizeSkillName(skillName);
    const store = await this.readStore();

    const nextState = buildDefaultState();
    store[normalizedName] = nextState;
    await this.writeStore(store);
    this.cache = store;
    this.cacheLoadedAt = Date.now();

    this.logger?.info('Skill authorization revoked', { skillName: normalizedName });

    return nextState;
  }

  async isEnabled(skillName: string): Promise<boolean> {
    const state = await this.getState(skillName);
    return state.enabled;
  }

  async listAll(): Promise<Record<string, AuthorizationState>> {
    const store = await this.getCachedStore();
    const snapshot: Record<string, AuthorizationState> = {};

    for (const [skillName, state] of Object.entries(store)) {
      snapshot[skillName] = cloneState(state);
    }

    return snapshot;
  }

  private async getCachedStore(): Promise<AuthorizationStore> {
    const now = Date.now();
    if (this.cache && (now - this.cacheLoadedAt) < this.cacheTtlMs) return this.cache;
    const store = await this.readStore();
    this.cache = store;
    this.cacheLoadedAt = now;
    return store;
  }

  private async readStore(): Promise<AuthorizationStore> {
    try {
      const raw = await readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        return {};
      }

      const store: AuthorizationStore = {};
      for (const [skillName, rawState] of Object.entries(parsed)) {
        const normalizedName = String(skillName || '').trim().toLowerCase();
        if (!normalizedName) {
          continue;
        }
        const state = parseState(rawState);
        if (state) {
          store[normalizedName] = state;
        }
      }

      return store;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        return {};
      }
      throw new Error('Failed to read skill authorization store', { cause: error });
    }
  }

  private async writeStore(store: AuthorizationStore): Promise<void> {
    try {
      await mkdir(path.dirname(this.storagePath), { recursive: true });
      await writeFile(this.storagePath, JSON.stringify(store, null, 2), 'utf8');
    } catch (error) {
      throw new Error('Failed to write skill authorization store', { cause: error });
    }
  }
}
