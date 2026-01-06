import path from 'path';
import type { SkillCapabilities } from './CapabilityManifest.js';

export type FileAccessOperation = 'read' | 'write';

export interface FileAccessEvent {
  path: string;
  operation: FileAccessOperation;
}

export interface NetworkConnectionEvent {
  host: string;
  port: number;
}

export interface SubprocessSpawnEvent {
  command: string;
  argv?: string[];
}

export interface ExecutionTrace {
  fileAccesses: FileAccessEvent[];
  networkConnections: NetworkConnectionEvent[];
  envAccessed: string[];
  subprocesses: SubprocessSpawnEvent[];
}

export type ViolationSeverity = 'low' | 'medium' | 'high' | 'critical';

export type Violation =
  | {
      type: 'filesystem';
      operation: FileAccessOperation;
      path: string;
      severity: ViolationSeverity;
      message: string;
    }
  | {
      type: 'network';
      host: string;
      port: number;
      severity: ViolationSeverity;
      message: string;
    }
  | {
      type: 'env';
      variable: string;
      severity: ViolationSeverity;
      message: string;
    }
  | {
      type: 'subprocess';
      command: string;
      argv: string[];
      severity: ViolationSeverity;
      message: string;
    };

export interface BehaviorValidationResult {
  violations: Violation[];
  /**
   * A compliance score in the range [0, 100]. 100 means no observed deviations.
   */
  score: number;
}

const SEVERITY_PENALTY: Record<ViolationSeverity, number> = {
  low: 5,
  medium: 10,
  high: 25,
  critical: 40
};

function normalizeHost(raw: string): string {
  const host = String(raw ?? '').trim().toLowerCase();
  if (!host) return '';
  const withoutBrackets = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return withoutBrackets.endsWith('.') ? withoutBrackets.slice(0, -1) : withoutBrackets;
}

function hostMatchesAllowedEntry(allowedHost: string, actualHost: string): boolean {
  const allowed = normalizeHost(allowedHost);
  const actual = normalizeHost(actualHost);
  if (!allowed || !actual) return false;
  if (allowed === '*') return true;
  if (actual === allowed) return true;
  return actual.endsWith(`.${allowed}`);
}

function basenameCrossPlatform(cmd: string): string {
  const normalized = String(cmd ?? '').trim().replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
}

function normalizeFsPath(raw: string): string {
  const converted = String(raw).trim().replace(/\\/g, '/');
  if (!converted) return '';
  const normalized = path.posix.normalize(converted);
  if (normalized === '.') return '';
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function isLikelyAbsolutePath(raw: string): boolean {
  const p = String(raw).replace(/\\/g, '/');
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

function expandPathCandidates(raw: string): string[] {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return [];
  const candidates = new Set<string>();

  const normalized = normalizeFsPath(trimmed);
  if (normalized) candidates.add(normalized);

  if (!isLikelyAbsolutePath(trimmed)) {
    const resolved = normalizeFsPath(path.resolve(trimmed));
    if (resolved) candidates.add(resolved);
  }

  return [...candidates];
}

function matchesNormalizedPrefix(prefix: string, target: string): boolean {
  if (target === prefix) return true;

  const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return target.startsWith(withSlash);
}

function matchesAnyPathPrefix(prefixRaw: string, targetRaw: string): boolean {
  const prefixes = expandPathCandidates(prefixRaw);
  const targets = expandPathCandidates(targetRaw);
  for (const prefix of prefixes) {
    for (const target of targets) {
      if (matchesNormalizedPrefix(prefix, target)) return true;
    }
  }
  return false;
}

const SENSITIVE_ENV_RE =
  /(SECRET|TOKEN|PASSWORD|PASS|PWD|KEY|CREDENTIAL|PRIVATE|COOKIE|BEARER|SSH|AWS|GCP|AZURE|OPENAI|ANTHROPIC|GITHUB)/i;

function envVarLooksSensitive(variable: string): boolean {
  return SENSITIVE_ENV_RE.test(variable);
}

function isDeclaredFsAccessAllowed(declared: SkillCapabilities, access: FileAccessEvent): boolean {
  const list = access.operation === 'write' ? declared.filesystem.write : declared.filesystem.read;
  if (!Array.isArray(list) || list.length === 0) return false;
  for (const prefix of list) {
    if (matchesAnyPathPrefix(prefix, access.path)) return true;
  }
  return false;
}

function isDeclaredNetworkAllowed(declared: SkillCapabilities, conn: NetworkConnectionEvent): boolean {
  const { allowedHosts, allowedPorts } = declared.network;
  if (!Array.isArray(allowedHosts) || !Array.isArray(allowedPorts)) return false;
  if (allowedHosts.length === 0 || allowedPorts.length === 0) return false;

  const hostAllowed = allowedHosts.some((h) => hostMatchesAllowedEntry(h, conn.host));
  if (!hostAllowed) return false;
  return allowedPorts.includes(conn.port);
}

export class BehaviorValidator {
  validate(declared: SkillCapabilities, actual: ExecutionTrace): BehaviorValidationResult {
    const violations: Violation[] = [];
    const seen = new Set<string>();

    const addViolation = (key: string, violation: Violation): void => {
      if (seen.has(key)) return;
      seen.add(key);
      violations.push(violation);
    };

    for (const access of actual.fileAccesses || []) {
      if (!access || typeof access.path !== 'string') continue;
      if (access.operation !== 'read' && access.operation !== 'write') continue;
      if (isDeclaredFsAccessAllowed(declared, access)) continue;

      const normalizedPath = normalizeFsPath(access.path) || access.path;
      const severity: ViolationSeverity = access.operation === 'write' ? 'high' : 'medium';
      addViolation(`filesystem:${access.operation}:${normalizedPath}`, {
        type: 'filesystem',
        operation: access.operation,
        path: access.path,
        severity,
        message: `Undeclared filesystem ${access.operation}: ${access.path}`
      });
    }

    for (const conn of actual.networkConnections || []) {
      if (!conn || typeof conn.host !== 'string' || typeof conn.port !== 'number') continue;
      if (Number.isNaN(conn.port)) continue;
      if (isDeclaredNetworkAllowed(declared, conn)) continue;

      const host = normalizeHost(conn.host) || conn.host;
      addViolation(`network:${host}:${conn.port}`, {
        type: 'network',
        host: conn.host,
        port: conn.port,
        severity: 'high',
        message: `Undeclared network connection: ${conn.host}:${conn.port}`
      });
    }

    const envAllowed = new Set((declared.env || []).map((v) => String(v)));
    for (const name of actual.envAccessed || []) {
      const variable = String(name ?? '').trim();
      if (!variable) continue;
      if (envAllowed.has(variable)) continue;
      const severity: ViolationSeverity = envVarLooksSensitive(variable) ? 'critical' : 'high';
      addViolation(`env:${variable}`, {
        type: 'env',
        variable,
        severity,
        message: `Undeclared environment variable read: ${variable}`
      });
    }

    const allowedCommands = new Set((declared.subprocess.allowedCommands || []).map((c) => basenameCrossPlatform(c)));
    for (const proc of actual.subprocesses || []) {
      if (!proc || typeof proc.command !== 'string') continue;
      const cmdBase = basenameCrossPlatform(proc.command);

      if (!declared.subprocess.allowed) {
        addViolation(`subprocess:disabled:${cmdBase}`, {
          type: 'subprocess',
          command: proc.command,
          argv: Array.isArray(proc.argv) ? proc.argv.map(String) : [],
          severity: 'critical',
          message: `Undeclared subprocess spawn: ${proc.command}`
        });
        continue;
      }

      if (!allowedCommands.has(cmdBase)) {
        addViolation(`subprocess:not-allowed:${cmdBase}`, {
          type: 'subprocess',
          command: proc.command,
          argv: Array.isArray(proc.argv) ? proc.argv.map(String) : [],
          severity: 'high',
          message: `Subprocess command not declared: ${proc.command}`
        });
      }
    }

    const totalPenalty = violations.reduce((sum, v) => sum + SEVERITY_PENALTY[v.severity], 0);
    const score = Math.max(0, 100 - totalPenalty);
    return { violations, score };
  }
}
