import path from 'path';

/**
 * Extract the base command name from a potentially path-qualified command,
 * normalizing path separators and stripping common Windows executable extensions.
 */
export function basenameCrossPlatform(cmd: string): string {
  const normalized = String(cmd ?? '').trim().replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
}

/**
 * Strip an npm version specifier from a package name.
 * E.g. "@scope/pkg@1.2.3" → "@scope/pkg", "pkg@latest" → "pkg".
 */
export function stripNpmVersion(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('.') || trimmed.startsWith('/') || trimmed.startsWith('file:') || trimmed.startsWith('git+')) return trimmed;

  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/');
    if (slash < 0) return trimmed;
    const lastAt = trimmed.lastIndexOf('@');
    if (lastAt > slash) return trimmed.slice(0, lastAt);
    return trimmed;
  }

  const at = trimmed.indexOf('@');
  if (at > 0) return trimmed.slice(0, at);
  return trimmed;
}

/**
 * Extract the package name from `npm exec` style args.
 */
export function extractNpmExecPackage(args: string[]): string | undefined {
  const idx = args.indexOf('exec');
  if (idx < 0) return undefined;

  for (let i = idx + 1; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token) continue;

    if (token === '--package' || token === '-p') {
      const next = String(args[i + 1] ?? '');
      if (next) return stripNpmVersion(next);
      continue;
    }
    if (token.startsWith('--package=')) return stripNpmVersion(token.slice('--package='.length));

    if (token.startsWith('-')) continue;
    return stripNpmVersion(token);
  }

  return undefined;
}

/**
 * Extract the package name from `npx` style args.
 */
export function extractNpxPackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token) continue;

    if (token === '--package' || token === '-p') {
      const next = String(args[i + 1] ?? '');
      if (next) return stripNpmVersion(next);
      continue;
    }
    if (token.startsWith('--package=')) return stripNpmVersion(token.slice('--package='.length));
    if (token.startsWith('-')) continue;
    return stripNpmVersion(token);
  }
  return undefined;
}

/**
 * Infer the portable packages directory for a given npm package name.
 */
export function inferPortablePackagesDir(pkg?: string): string | undefined {
  if (!pkg) return undefined;
  const cleaned = stripNpmVersion(pkg);
  if (!cleaned) return undefined;

  const packagesRoot = path.resolve(process.cwd(), '../mcp-sandbox/packages');
  if (cleaned.startsWith('@') && cleaned.includes('/')) {
    const scope = cleaned.split('/')[0] as string;
    return path.join(packagesRoot, scope);
  }
  return packagesRoot;
}
