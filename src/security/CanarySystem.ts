import crypto from 'crypto';
import path from 'path';
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'fs/promises';

export interface CanarySetupEntry {
  relativePath: string;
  token: string;
}

export interface CanarySetup {
  sandboxRoot: string;
  stateFilePath: string;
  canaries: CanarySetupEntry[];
}

export interface CanaryCheckResult {
  triggered: boolean;
  accessedFiles: string[];
}

interface CanaryStateEntryV1 extends CanarySetupEntry {
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface CanaryStateV1 {
  version: 1;
  createdAt: string;
  canaries: CanaryStateEntryV1[];
}

const DEFAULT_CANARY_FILES: Array<{ relativePath: string; mode: number; render: (token: string) => string }> = [
  {
    relativePath: '.env',
    mode: 0o600,
    render: (token) => `AWS_SECRET_KEY=${token}\n`
  },
  {
    relativePath: '.ssh/id_rsa',
    mode: 0o600,
    render: (token) => `-----BEGIN RSA PRIVATE KEY-----\n${token}\n-----END RSA PRIVATE KEY-----\n`
  },
  {
    relativePath: '.aws/credentials',
    mode: 0o600,
    render: (token) => `[default]\naws_access_key_id = ${token}\naws_secret_access_key = ${token}\n`
  },
  {
    relativePath: '.npmrc',
    mode: 0o600,
    render: (token) => `registry=https://registry.npmjs.org/\n_authToken=${token}\n`
  }
];

const CANARY_STATE_DIR = '.pb-canary';
const CANARY_STATE_FILE = 'state.json';
const PRIME_ATIME_TO = new Date('2000-01-01T00:00:00.000Z');

function normalizeMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

function makeToken(): string {
  return `CANARY_${crypto.randomBytes(16).toString('hex')}`;
}

function statePathForRoot(sandboxRoot: string): string {
  return path.join(sandboxRoot, CANARY_STATE_DIR, CANARY_STATE_FILE);
}

async function safeChmod(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch {
    // Best-effort; chmod may not be supported on some filesystems.
  }
}

async function primeAccessTime(filePath: string): Promise<void> {
  try {
    await utimes(filePath, PRIME_ATIME_TO, new Date());
  } catch {
    // Best-effort; utimes may not be supported on some filesystems.
  }
}

function defaultCanaryRelativePaths(): string[] {
  return DEFAULT_CANARY_FILES.map((c) => c.relativePath);
}

export async function setupCanaries(sandboxRoot: string): Promise<CanarySetup> {
  const canaries: CanarySetupEntry[] = [];
  const stateEntries: CanaryStateEntryV1[] = [];

  for (const spec of DEFAULT_CANARY_FILES) {
    const token = makeToken();
    canaries.push({ relativePath: spec.relativePath, token });

    const absolutePath = path.join(sandboxRoot, spec.relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, spec.render(token), { encoding: 'utf8' });
    await safeChmod(absolutePath, spec.mode);
    await primeAccessTime(absolutePath);

    const info = await stat(absolutePath);
    stateEntries.push({
      relativePath: spec.relativePath,
      token,
      size: info.size,
      atimeMs: normalizeMs(info.atimeMs),
      mtimeMs: normalizeMs(info.mtimeMs),
      ctimeMs: normalizeMs(info.ctimeMs)
    });
  }

  const stateFilePath = statePathForRoot(sandboxRoot);
  await mkdir(path.dirname(stateFilePath), { recursive: true });
  const state: CanaryStateV1 = {
    version: 1,
    createdAt: new Date().toISOString(),
    canaries: stateEntries
  };
  await writeFile(stateFilePath, JSON.stringify(state, null, 2), { encoding: 'utf8' });

  return { sandboxRoot, stateFilePath, canaries };
}

async function loadState(sandboxRoot: string): Promise<CanaryStateV1> {
  const raw = await readFile(statePathForRoot(sandboxRoot), { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as Partial<CanaryStateV1>;
  if (parsed.version !== 1 || !Array.isArray(parsed.canaries)) {
    throw new Error('invalid canary state');
  }
  return parsed as CanaryStateV1;
}

export async function checkCanaryAccess(sandboxRoot: string): Promise<CanaryCheckResult> {
  let state: CanaryStateV1 | undefined;
  try {
    state = await loadState(sandboxRoot);
  } catch {
    const accessedFiles = defaultCanaryRelativePaths();
    return { triggered: accessedFiles.length > 0, accessedFiles };
  }

  const accessedFiles: string[] = [];

  for (const canary of state.canaries) {
    const absolutePath = path.join(sandboxRoot, canary.relativePath);
    try {
      const info = await stat(absolutePath);
      const atimeMs = normalizeMs(info.atimeMs);
      const mtimeMs = normalizeMs(info.mtimeMs);
      const ctimeMs = normalizeMs(info.ctimeMs);
      const accessed =
        info.size !== canary.size ||
        atimeMs !== canary.atimeMs ||
        mtimeMs !== canary.mtimeMs ||
        ctimeMs !== canary.ctimeMs;
      if (accessed) accessedFiles.push(canary.relativePath);
    } catch {
      accessedFiles.push(canary.relativePath);
    }
  }

  return { triggered: accessedFiles.length > 0, accessedFiles };
}

