export interface FilesystemCapabilities {
  /**
   * Whitelisted paths the skill may read.
   * Paths are treated as prefixes; interpretation is enforced by the sandbox layer.
   */
  read: string[];
  /**
   * Whitelisted paths the skill may write.
   * Paths are treated as prefixes; interpretation is enforced by the sandbox layer.
   */
  write: string[];
}

export interface NetworkCapabilities {
  /**
   * Allowed hosts (hostname / domain / IP). Empty means "no outbound network".
   */
  allowedHosts: string[];
  /**
   * Allowed TCP ports. Empty means "no outbound network".
   */
  allowedPorts: number[];
}

export interface SubprocessCapabilities {
  /**
   * Whether the skill is permitted to spawn subprocesses at all.
   */
  allowed: boolean;
  /**
   * Whitelisted command basenames (e.g. "git", "node"). Only used when `allowed=true`.
   */
  allowedCommands: string[];
}

export interface ResourceCapabilities {
  /**
   * Maximum memory allowed for skill execution (MB).
   */
  maxMemoryMB: number;
  /**
   * Maximum CPU usage as a percentage (0-100].
   */
  maxCpuPercent: number;
  /**
   * Maximum execution time for skill operations (ms).
   */
  timeoutMs: number;
}

export interface SkillCapabilities {
  filesystem: FilesystemCapabilities;
  network: NetworkCapabilities;
  /**
   * Whitelisted environment variables the skill may read.
   */
  env: string[];
  subprocess: SubprocessCapabilities;
  resources: ResourceCapabilities;
}

export const DEFAULT_SKILL_CAPABILITIES: SkillCapabilities = {
  filesystem: { read: [], write: [] },
  network: { allowedHosts: [], allowedPorts: [] },
  env: [],
  subprocess: { allowed: false, allowedCommands: [] },
  resources: { maxMemoryMB: 512, maxCpuPercent: 50, timeoutMs: 60_000 }
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value
    .map((v) => String(v))
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeNumberArray(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const out: number[] = [];
  for (const raw of value) {
    if (typeof raw === 'number') {
      out.push(raw);
      continue;
    }
    if (typeof raw === 'string' && raw.trim().length) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) out.push(parsed);
      else throw new Error(`${label} contains a non-numeric value`);
      continue;
    }
    throw new Error(`${label} contains an invalid value`);
  }
  return out;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : (typeof value === 'string' ? Number(value) : NaN);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
}

/**
 * Merge a possibly-partial capability manifest with defaults.
 * This does not attempt to "union" lists; explicit lists override defaults.
 */
export function mergeWithDefaults(
  input?: Partial<SkillCapabilities>,
  defaults: SkillCapabilities = DEFAULT_SKILL_CAPABILITIES
): SkillCapabilities {
  if (input === undefined) {
    return {
      filesystem: { read: [...defaults.filesystem.read], write: [...defaults.filesystem.write] },
      network: { allowedHosts: [...defaults.network.allowedHosts], allowedPorts: [...defaults.network.allowedPorts] },
      env: [...defaults.env],
      subprocess: { allowed: defaults.subprocess.allowed, allowedCommands: [...defaults.subprocess.allowedCommands] },
      resources: { ...defaults.resources }
    };
  }
  if (!isPlainObject(input)) {
    throw new Error('capabilities must be an object');
  }

  const fsRaw = (input as any).filesystem;
  const netRaw = (input as any).network;
  const envRaw = (input as any).env;
  const subRaw = (input as any).subprocess;
  const resRaw = (input as any).resources;

  const filesystem: FilesystemCapabilities = (() => {
    if (fsRaw === undefined) return { ...defaults.filesystem, read: [...defaults.filesystem.read], write: [...defaults.filesystem.write] };
    if (!isPlainObject(fsRaw)) throw new Error('capabilities.filesystem must be an object');
    const read = hasOwn(fsRaw, 'read') ? normalizeStringArray((fsRaw as any).read, 'capabilities.filesystem.read') : [...defaults.filesystem.read];
    const write = hasOwn(fsRaw, 'write') ? normalizeStringArray((fsRaw as any).write, 'capabilities.filesystem.write') : [...defaults.filesystem.write];
    return { read, write };
  })();

  const network: NetworkCapabilities = (() => {
    if (netRaw === undefined) return { ...defaults.network, allowedHosts: [...defaults.network.allowedHosts], allowedPorts: [...defaults.network.allowedPorts] };
    if (!isPlainObject(netRaw)) throw new Error('capabilities.network must be an object');
    const allowedHosts = hasOwn(netRaw, 'allowedHosts')
      ? normalizeStringArray((netRaw as any).allowedHosts, 'capabilities.network.allowedHosts')
      : [...defaults.network.allowedHosts];
    const allowedPorts = hasOwn(netRaw, 'allowedPorts')
      ? normalizeNumberArray((netRaw as any).allowedPorts, 'capabilities.network.allowedPorts')
      : [...defaults.network.allowedPorts];
    return { allowedHosts, allowedPorts };
  })();

  const env = envRaw === undefined ? [...defaults.env] : normalizeStringArray(envRaw, 'capabilities.env');

  const subprocess: SubprocessCapabilities = (() => {
    if (subRaw === undefined) {
      return {
        allowed: defaults.subprocess.allowed,
        allowedCommands: [...defaults.subprocess.allowedCommands]
      };
    }
    if (!isPlainObject(subRaw)) throw new Error('capabilities.subprocess must be an object');
    const allowed = normalizeBoolean((subRaw as any).allowed, defaults.subprocess.allowed);
    const allowedCommands = hasOwn(subRaw, 'allowedCommands')
      ? normalizeStringArray((subRaw as any).allowedCommands, 'capabilities.subprocess.allowedCommands')
      : [...defaults.subprocess.allowedCommands];
    return { allowed, allowedCommands };
  })();

  const resources: ResourceCapabilities = (() => {
    if (resRaw === undefined) return { ...defaults.resources };
    if (!isPlainObject(resRaw)) throw new Error('capabilities.resources must be an object');
    return {
      maxMemoryMB: normalizeInt((resRaw as any).maxMemoryMB, defaults.resources.maxMemoryMB, 'capabilities.resources.maxMemoryMB'),
      maxCpuPercent: normalizeInt((resRaw as any).maxCpuPercent, defaults.resources.maxCpuPercent, 'capabilities.resources.maxCpuPercent'),
      timeoutMs: normalizeInt((resRaw as any).timeoutMs, defaults.resources.timeoutMs, 'capabilities.resources.timeoutMs')
    };
  })();

  return { filesystem, network, env, subprocess, resources };
}

function assertNonEmptyStrings(values: string[], label: string): void {
  for (const v of values) {
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`${label} must contain non-empty strings`);
    }
    if (v.includes('\0')) throw new Error(`${label} contains invalid characters`);
  }
}

function assertEnvVarNames(vars: string[]): void {
  const re = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const v of vars) {
    if (!re.test(v)) {
      throw new Error(`capabilities.env contains invalid env var name: "${v}"`);
    }
  }
}

function assertIntInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
}

/**
 * Validate that a capability manifest is complete and well-formed.
 * Throws an Error with a descriptive message when invalid.
 */
export function validateCapabilities(capabilities: unknown): asserts capabilities is SkillCapabilities {
  if (!isPlainObject(capabilities)) throw new Error('capabilities must be an object');

  const fs = (capabilities as any).filesystem;
  if (!isPlainObject(fs)) throw new Error('capabilities.filesystem must be an object');
  const fsRead = (fs as any).read;
  const fsWrite = (fs as any).write;
  if (!Array.isArray(fsRead)) throw new Error('capabilities.filesystem.read must be an array');
  if (!Array.isArray(fsWrite)) throw new Error('capabilities.filesystem.write must be an array');
  assertNonEmptyStrings(fsRead, 'capabilities.filesystem.read');
  assertNonEmptyStrings(fsWrite, 'capabilities.filesystem.write');

  const net = (capabilities as any).network;
  if (!isPlainObject(net)) throw new Error('capabilities.network must be an object');
  const hosts = (net as any).allowedHosts;
  const ports = (net as any).allowedPorts;
  if (!Array.isArray(hosts)) throw new Error('capabilities.network.allowedHosts must be an array');
  if (!Array.isArray(ports)) throw new Error('capabilities.network.allowedPorts must be an array');
  assertNonEmptyStrings(hosts, 'capabilities.network.allowedHosts');
  for (const p of ports) {
    if (typeof p !== 'number') throw new Error('capabilities.network.allowedPorts must contain numbers');
    assertIntInRange(p, 1, 65535, 'capabilities.network.allowedPorts');
  }

  const env = (capabilities as any).env;
  if (!Array.isArray(env)) throw new Error('capabilities.env must be an array');
  assertNonEmptyStrings(env, 'capabilities.env');
  assertEnvVarNames(env);

  const sub = (capabilities as any).subprocess;
  if (!isPlainObject(sub)) throw new Error('capabilities.subprocess must be an object');
  const subAllowed = (sub as any).allowed;
  const subCommands = (sub as any).allowedCommands;
  if (typeof subAllowed !== 'boolean') throw new Error('capabilities.subprocess.allowed must be a boolean');
  if (!Array.isArray(subCommands)) throw new Error('capabilities.subprocess.allowedCommands must be an array');
  assertNonEmptyStrings(subCommands, 'capabilities.subprocess.allowedCommands');
  if (!subAllowed && subCommands.length > 0) {
    throw new Error('capabilities.subprocess.allowedCommands must be empty when subprocess.allowed=false');
  }
  if (subAllowed && subCommands.length === 0) {
    throw new Error('capabilities.subprocess.allowedCommands is required when subprocess.allowed=true');
  }

  const res = (capabilities as any).resources;
  if (!isPlainObject(res)) throw new Error('capabilities.resources must be an object');
  const mem = (res as any).maxMemoryMB;
  const cpu = (res as any).maxCpuPercent;
  const timeout = (res as any).timeoutMs;
  if (typeof mem !== 'number') throw new Error('capabilities.resources.maxMemoryMB must be a number');
  if (typeof cpu !== 'number') throw new Error('capabilities.resources.maxCpuPercent must be a number');
  if (typeof timeout !== 'number') throw new Error('capabilities.resources.timeoutMs must be a number');
  assertIntInRange(mem, 1, 1024 * 1024, 'capabilities.resources.maxMemoryMB');
  assertIntInRange(cpu, 1, 100, 'capabilities.resources.maxCpuPercent');
  assertIntInRange(timeout, 1, 24 * 60 * 60 * 1000, 'capabilities.resources.timeoutMs');
}

