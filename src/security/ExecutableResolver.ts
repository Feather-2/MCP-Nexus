import fs from 'fs';
import path from 'path';

export interface ResolvedExecutable {
  originalCommand: string;
  resolvedPath: string;
  realPath: string;
  matchedAllowedRoot?: string;
}

export interface ExecutableResolverOptions {
  cwd?: string;
  pathEnv?: string;
  allowedRoots?: string[];
  platform?: NodeJS.Platform;
  pathext?: string;
}

type PathFlavor = 'posix' | 'win32';

function detectPathFlavor(value: string): PathFlavor {
  const v = String(value || '');
  if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\')) return 'win32';
  if (v.includes('\\')) return 'win32';
  return 'posix';
}

function isPathWithinRootCrossPlatform(targetPath: string, rootPath: string): boolean {
  const targetFlavor = detectPathFlavor(targetPath);
  const rootFlavor = detectPathFlavor(rootPath);
  const mod = targetFlavor === 'win32' || rootFlavor === 'win32' ? path.win32 : path.posix;
  const isWin = mod === path.win32;

  const normalizedRoot = mod.normalize(rootPath);
  const normalizedTarget = mod.normalize(targetPath);

  const rootComparable = isWin ? normalizedRoot.toLowerCase() : normalizedRoot;
  const targetComparable = isWin ? normalizedTarget.toLowerCase() : normalizedTarget;

  const rel = mod.relative(rootComparable, targetComparable);
  return rel === '' || (!rel.startsWith('..' + mod.sep) && rel !== '..' && !mod.isAbsolute(rel));
}

function splitPathEnv(pathEnv: string | undefined): string[] {
  if (!pathEnv) return [];
  return String(pathEnv)
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

function normalizeDirCandidates(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    let resolved = path.resolve(entry);
    try {
      const st = fs.statSync(resolved);
      if (st.isDirectory()) {
        resolved = fs.realpathSync(resolved);
      }
    } catch {
      // Keep the resolved string even if it doesn't exist.
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function defaultWindowsPathext(pathext?: string): string[] {
  const raw = pathext ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
  const exts = String(raw)
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  return exts.length ? exts : ['.EXE', '.CMD', '.BAT', '.COM'];
}

function isFileExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasAnyPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function looksLikeWindowsAbsolutePath(command: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(command) || command.startsWith('\\\\');
}

export class ExecutableResolver {
  private readonly cwd: string;
  private readonly platform: NodeJS.Platform;
  private readonly allowedRoots: string[];
  private readonly searchPaths: string[];
  private readonly winPathext: string[];

  constructor(opts: ExecutableResolverOptions = {}) {
    this.cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    this.platform = opts.platform ?? process.platform;
    this.searchPaths = normalizeDirCandidates(splitPathEnv(opts.pathEnv ?? process.env.PATH));
    this.allowedRoots = normalizeDirCandidates(
      (opts.allowedRoots && opts.allowedRoots.length ? opts.allowedRoots : ExecutableResolver.getDefaultAllowedRoots())
    );
    this.winPathext = this.platform === 'win32' ? defaultWindowsPathext(opts.pathext) : [];
  }

  static getDefaultAllowedRoots(): string[] {
    const roots: string[] = [];
    // Prefer system PATH as the baseline allowlist; templates must not expand it via env overrides.
    roots.push(...splitPathEnv(process.env.PATH));
    // Allow the Node runtime installation root to support common symlink layouts
    // (e.g. `npm` in PATH → realpath under `${nodeRoot}/lib/node_modules/...`).
    const nodeRoot = path.resolve(process.execPath, '..', '..');
    if (path.parse(nodeRoot).root !== nodeRoot) roots.push(nodeRoot);
    // Allow portable sandbox runtimes + workspace tools when present.
    roots.push(path.resolve(process.cwd(), '../mcp-sandbox'));
    roots.push(path.resolve(process.cwd(), 'node_modules', '.bin'));
    roots.push(path.resolve(process.cwd()));
    return normalizeDirCandidates(roots);
  }

  static isWithinAllowedRoot(targetPath: string, rootPath: string): boolean {
    return isPathWithinRootCrossPlatform(targetPath, rootPath);
  }

  resolveOrThrow(command: string): ResolvedExecutable {
    const trimmed = String(command || '').trim();
    if (!trimmed) {
      throw new Error('ExecutableResolver: empty command');
    }

    const candidate = this.resolveCandidate(trimmed);
    if (!candidate) {
      throw new Error(`ExecutableResolver: command not found in allowed search path: ${trimmed}`);
    }

    let realPath: string;
    try {
      realPath = fs.realpathSync(candidate);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`ExecutableResolver: failed to realpath ${candidate}: ${msg}`);
    }

    const matchedAllowedRoot = this.allowedRoots.find((root) => isPathWithinRootCrossPlatform(realPath, root));
    if (!matchedAllowedRoot) {
      throw new Error(`ExecutableResolver: executable is outside allowed roots: ${realPath}`);
    }

    return {
      originalCommand: trimmed,
      resolvedPath: candidate,
      realPath,
      matchedAllowedRoot
    };
  }

  private resolveCandidate(command: string): string | undefined {
    // If command looks like a path (absolute or relative), resolve against cwd.
    if (hasAnyPathSeparator(command) || path.isAbsolute(command) || looksLikeWindowsAbsolutePath(command)) {
      const absolute = path.isAbsolute(command) ? command : path.resolve(this.cwd, command);
      const found = this.expandAndPickExecutable(absolute);
      return found;
    }

    // Otherwise, resolve via safe PATH search (never using template-provided PATH).
    for (const dir of this.searchPaths) {
      const joined = path.join(dir, command);
      const found = this.expandAndPickExecutable(joined);
      if (found) return found;
    }

    return undefined;
  }

  private expandAndPickExecutable(basePath: string): string | undefined {
    // Exact match first
    if (isFileExecutable(basePath, this.platform)) return basePath;

    // Windows PATHEXT expansion
    if (this.platform === 'win32') {
      const ext = path.extname(basePath);
      if (ext) return undefined;
      for (const e of this.winPathext) {
        const candidate = basePath + e.toLowerCase();
        if (isFileExecutable(candidate, this.platform)) return candidate;
        const candidateUpper = basePath + e.toUpperCase();
        if (isFileExecutable(candidateUpper, this.platform)) return candidateUpper;
        const candidateRaw = basePath + e;
        if (isFileExecutable(candidateRaw, this.platform)) return candidateRaw;
      }
    }

    return undefined;
  }
}
