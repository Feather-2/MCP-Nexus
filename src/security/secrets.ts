import type { McpServiceConfig } from '../types/index.js';

const DEFAULT_SENSITIVE_KEYWORDS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'set-cookie',
  'cookie',
  'private'
];

export function isEnvRef(value: unknown): value is string {
  return typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

export function extractEnvRefName(value: string): string {
  return value.slice(2, -1);
}

export function isSensitiveKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;

  // Strong signals first
  if (DEFAULT_SENSITIVE_KEYWORDS.some((w) => k.includes(w))) return true;

  // Common provider patterns
  if (k.endsWith('_key') || k.endsWith('_token') || k.endsWith('_secret') || k.endsWith('_password')) return true;
  if (k.includes('api-key') || k.includes('api_key')) return true;

  return false;
}

export function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string') return '***';
  const trimmed = value.trim();
  if (!trimmed) return '***';
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function redactEnv(env?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!env) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isSensitiveKey(k) && !isEnvRef(v)) {
      out[k] = maskSecret(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function redactMcpServiceConfig(config: McpServiceConfig): McpServiceConfig {
  const clone = { ...config };
  if (config.env) clone.env = redactEnv(config.env) as Record<string, string> | undefined;
  return clone;
}

export function findPlaintextSecrets(config: McpServiceConfig): string[] {
  const hits: string[] = [];
  const env = config.env as Record<string, unknown> | undefined;
  if (!env) return hits;

  for (const [k, v] of Object.entries(env)) {
    if (!isSensitiveKey(k)) continue;
    if (isEnvRef(v)) continue;
    if (typeof v === 'string' && v.trim().length > 0) hits.push(k);
  }
  return hits;
}

export function assertNoPlaintextSecrets(
  config: McpServiceConfig,
  opts?: { allowInsecure?: boolean; label?: string }
): void {
  if (opts?.allowInsecure) return;
  const keys = findPlaintextSecrets(config);
  if (keys.length === 0) return;

  const label = opts?.label ? `${opts.label}: ` : '';
  throw new Error(
    `${label}Refusing to persist plaintext secrets in template env: ${keys.join(', ')}. ` +
    `Use env references like "\${VAR}" (e.g. {"${keys[0]}":"\${${keys[0]}}"}), or set PB_ALLOW_PLAINTEXT_SECRETS=1 to override (not recommended).`
  );
}

export function resolveEnvRefs(input?: Record<string, unknown>, sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (isEnvRef(v)) {
      const name = extractEnvRefName(v);
      out[k] = sourceEnv[name] ?? v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function resolveArgsEnvRefs(args?: unknown[], sourceEnv: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if (!args) return undefined;
  return args.map((a) => {
    const s = String(a);
    if (isEnvRef(s)) {
      const name = extractEnvRefName(s);
      return sourceEnv[name] ?? s;
    }
    return s;
  });
}

export function resolveMcpServiceConfigEnvRefs(config: McpServiceConfig, sourceEnv: NodeJS.ProcessEnv = process.env): McpServiceConfig {
  const next = { ...config };
  if (config.env) next.env = resolveEnvRefs(config.env, sourceEnv) as Record<string, string> | undefined;
  if (config.args) next.args = resolveArgsEnvRefs(config.args, sourceEnv);
  return next;
}

