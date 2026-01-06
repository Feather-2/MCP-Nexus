import path from 'path';
import type { GatewayConfig, McpServiceConfig } from '../types/index.js';
import { ExecutableResolver } from './ExecutableResolver.js';

export type NormalizedSecurityProfile = 'dev' | 'default' | 'locked-down';
export type NormalizedPortableNetworkPolicy = 'full' | 'local-only' | 'blocked';
export type NormalizedContainerNetwork = 'none' | 'bridge';

export interface PortableSandboxRuntimePolicy {
  enabled: boolean;
  networkPolicy: NormalizedPortableNetworkPolicy;
}

export interface ContainerSandboxRuntimePolicy {
  defaultNetwork: NormalizedContainerNetwork;
  defaultReadonlyRootfs: boolean;
  allowedVolumeRoots: string[]; // absolute
  envSafePrefixes: string[];
  requiredForUntrusted: boolean;
  prefer: boolean;
}

export interface NormalizedSandboxPolicy {
  profile: NormalizedSecurityProfile;
  portable: PortableSandboxRuntimePolicy;
  container: ContainerSandboxRuntimePolicy;
}

export interface ApplyGatewaySandboxPolicyResult {
  config: McpServiceConfig;
  policy: NormalizedSandboxPolicy;
  applied: boolean;
  reasons: string[];
}

const DEFAULT_ALLOWED_VOLUME_ROOTS = ['../mcp-sandbox', './data'];
const DEFAULT_ENV_SAFE_PREFIXES = [
  'PB_',
  'PBMCP_',
  'MCP_',
  // Common provider keys (explicitly allow, but still only those present in template env)
  'BRAVE_',
  'GITHUB_',
  'OPENAI_',
  'AZURE_',
  'ANTHROPIC_',
  'GOOGLE_',
  'GROQ_',
  'DEEPSEEK_',
  'MISTRAL_',
  'BEDROCK_',
  // Networking hints (optional)
  'HTTP_',
  'HTTPS_',
  'NO_PROXY',
  'no_proxy'
];

function basenameCrossPlatform(cmd: string): string {
  const normalized = cmd.replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
}

function stripNpmVersion(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;
  // Ignore obvious non-package spec forms
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

function extractNpmExecPackage(args: string[]): string | undefined {
  const idx = args.indexOf('exec');
  if (idx < 0) return undefined;

  for (let i = idx + 1; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token) continue;

    // Common forms: npm exec -y <pkg> ...; npm exec --package <pkg> -- <cmd>
    if (token === '--package' || token === '-p') {
      const next = String(args[i + 1] ?? '');
      if (next) return stripNpmVersion(next);
      continue;
    }
    if (token.startsWith('--package=')) {
      return stripNpmVersion(token.slice('--package='.length));
    }

    if (token.startsWith('-')) continue;
    return stripNpmVersion(token);
  }

  return undefined;
}

function extractNpxPackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token) continue;

    if (token === '--package' || token === '-p') {
      const next = String(args[i + 1] ?? '');
      if (next) return stripNpmVersion(next);
      continue;
    }
    if (token.startsWith('--package=')) {
      return stripNpmVersion(token.slice('--package='.length));
    }
    if (token.startsWith('-')) continue;
    return stripNpmVersion(token);
  }
  return undefined;
}

function inferPortablePackagesDir(pkg?: string): string | undefined {
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

function applyPortableSandboxPolicy(template: McpServiceConfig, policy: NormalizedSandboxPolicy, reasons: string[]): { config: McpServiceConfig; applied: boolean } {
  if (!policy.portable.enabled) return { config: template, applied: false };
  if (template.transport !== 'stdio') return { config: template, applied: false };

  const cmdBase = basenameCrossPlatform(String((template as any).command || ''));
  const cmdKey = cmdBase.endsWith('.js') ? cmdBase.slice(0, -3) : cmdBase;
  const args = Array.isArray((template as any).args) ? ([...(template as any).args] as string[]) : [];
  const env = { ...((template as any).env || {}) } as Record<string, string>;

  const hasExplicitSandbox = typeof env.SANDBOX === 'string' && env.SANDBOX.length > 0;
  const isNpx = cmdKey === 'npx' || cmdKey === 'npx-cli';
  const isNpmExec = (cmdKey === 'npm' || cmdKey === 'npm-cli') && args.includes('exec');
  if (!isNpx && !isNpmExec) return { config: template, applied: false };

  let applied = false;
  if (!hasExplicitSandbox) {
    env.SANDBOX = 'portable';
    applied = true;
    reasons.push('sandbox.portable.auto');
  }

  if (env.SANDBOX !== 'portable') {
    return applied ? { config: { ...template, env }, applied } : { config: template, applied: false };
  }

  // Enforce offline behavior for portable sandbox unless explicitly allowed.
  const svcNet = (template as any)?.security?.networkPolicy as string | undefined;
  const effectiveNet: NormalizedPortableNetworkPolicy =
    svcNet === 'full' || svcNet === 'local-only' || svcNet === 'blocked'
      ? (svcNet as NormalizedPortableNetworkPolicy)
      : policy.portable.networkPolicy;

  if (effectiveNet !== 'full') {
    if (String(env.npm_config_offline || '') !== 'true') {
      env.npm_config_offline = 'true';
      applied = true;
      reasons.push(`sandbox.portable.networkPolicy=${effectiveNet}`);
    }
    if (String(env.npm_config_prefer_offline || '') !== 'true') {
      env.npm_config_prefer_offline = 'true';
      applied = true;
    }

    if (isNpx) {
      if (!args.includes('--no-install')) {
        // Remove install-encouraging flags when offline is enforced.
        const filtered = args.filter((a) => a !== '-y' && a !== '--yes');
        args.length = 0;
        args.push('--no-install', ...filtered);
        applied = true;
      }
    }
  }

  const pkg = isNpx ? extractNpxPackage(args) : extractNpmExecPackage(args);
  const inferredCwd = inferPortablePackagesDir(pkg);
  if (!template.workingDirectory && inferredCwd) {
    applied = true;
    reasons.push('sandbox.portable.cwd');
    return { config: { ...template, args, env, workingDirectory: inferredCwd }, applied };
  }

  return applied ? { config: { ...template, args, env }, applied } : { config: template, applied: false };
}

function normalizeStdioExecutableCommand(template: McpServiceConfig, reasons: string[]): McpServiceConfig {
  if (!template || template.transport !== 'stdio') return template;
  const command = String((template as any).command || '').trim();
  if (!command) return template;

  const resolver = new ExecutableResolver({
    cwd: template.workingDirectory ? path.resolve(String(template.workingDirectory)) : undefined
  });
  const resolved = resolver.resolveOrThrow(command);
  if (resolved.resolvedPath === command) return template;

  reasons.push('sandbox.exec.normalized');
  return { ...(template as any), command: resolved.resolvedPath } as McpServiceConfig;
}

export function normalizeSandboxPolicy(gatewayConfig?: GatewayConfig): NormalizedSandboxPolicy {
  const sandbox: any = (gatewayConfig as any)?.sandbox || {};

  const profile: NormalizedSecurityProfile =
    sandbox.profile === 'locked-down' || sandbox.profile === 'dev' || sandbox.profile === 'default'
      ? sandbox.profile
      : 'default';

  const portableCfg: any = sandbox.portable || {};
  const portableEnabled = typeof portableCfg.enabled === 'boolean' ? portableCfg.enabled : true;
  const portableNetworkPolicy: NormalizedPortableNetworkPolicy =
    portableCfg.networkPolicy === 'full' || portableCfg.networkPolicy === 'local-only' || portableCfg.networkPolicy === 'blocked'
      ? portableCfg.networkPolicy
      : 'local-only';

  const containerCfg: any = sandbox.container || {};
  const defaultNetwork: NormalizedContainerNetwork =
    containerCfg.defaultNetwork === 'bridge' || containerCfg.defaultNetwork === 'none'
      ? containerCfg.defaultNetwork
      : 'none';

  const defaultReadonlyRootfs =
    typeof containerCfg.defaultReadonlyRootfs === 'boolean' ? containerCfg.defaultReadonlyRootfs : true;

  const allowedVolumeRootsRaw: string[] = Array.isArray(containerCfg.allowedVolumeRoots) && containerCfg.allowedVolumeRoots.length
    ? containerCfg.allowedVolumeRoots.map((v: any) => String(v))
    : DEFAULT_ALLOWED_VOLUME_ROOTS;
  const allowedVolumeRoots = allowedVolumeRootsRaw.map((p) => path.resolve(process.cwd(), p));

  const envSafePrefixes: string[] = Array.isArray(containerCfg.envSafePrefixes) && containerCfg.envSafePrefixes.length
    ? containerCfg.envSafePrefixes.map((p: any) => String(p))
    : DEFAULT_ENV_SAFE_PREFIXES;

  const requiredForUntrusted =
    typeof containerCfg.requiredForUntrusted === 'boolean' ? containerCfg.requiredForUntrusted : false;
  const prefer = typeof containerCfg.prefer === 'boolean' ? containerCfg.prefer : false;

  return {
    profile,
    portable: {
      enabled: portableEnabled,
      networkPolicy: portableNetworkPolicy
    },
    container: {
      defaultNetwork,
      defaultReadonlyRootfs,
      allowedVolumeRoots,
      envSafePrefixes,
      requiredForUntrusted,
      prefer
    }
  };
}

function suggestContainerImage(template: McpServiceConfig): string {
  const cmd = String((template as any).command || '').toLowerCase();
  const args = Array.isArray((template as any).args) ? ((template as any).args as string[]).join(' ').toLowerCase() : '';
  if (cmd.includes('python') || args.includes('python')) return 'python:3.11-alpine';
  if (cmd.includes('go') || args.includes('golang') || args.includes('go ')) return 'golang:1.22-alpine';
  if (cmd.includes('node') || cmd.includes('npm') || cmd.includes('npx') || args.includes('node') || args.includes('npm') || args.includes('npx')) {
    return 'node:20-alpine';
  }
  return 'alpine:3';
}

function resolveTrustLevel(template: McpServiceConfig, policy: NormalizedSandboxPolicy): 'trusted' | 'partner' | 'untrusted' {
  const explicit = (template as any)?.security?.trustLevel;
  if (explicit === 'trusted' || explicit === 'partner' || explicit === 'untrusted') return explicit;
  // When quarantine is enabled, treat "missing trustLevel" as unreviewed/untrusted.
  if (policy.container.requiredForUntrusted) return 'untrusted';
  return 'trusted';
}

function validateVolumesAllowed(template: McpServiceConfig, policy: NormalizedSandboxPolicy): void {
  const vols = (template as any)?.container?.volumes;
  if (!Array.isArray(vols) || vols.length === 0) return;
  for (const v of vols) {
    if (!v || !v.hostPath || !v.containerPath) continue;
    const hostResolved = path.resolve(String(v.hostPath));
    const ok = policy.container.allowedVolumeRoots.some((root) => ExecutableResolver.isWithinAllowedRoot(hostResolved, root));
    if (!ok) {
      throw new Error(`Volume hostPath not allowed by policy: ${v.hostPath}`);
    }
    if (String(v.containerPath).includes('..')) {
      throw new Error(`Invalid containerPath: ${v.containerPath}`);
    }
  }
}

export function applyGatewaySandboxPolicy(template: McpServiceConfig, gatewayConfig?: GatewayConfig): ApplyGatewaySandboxPolicyResult {
  const policy = normalizeSandboxPolicy(gatewayConfig);
  const reasons: string[] = [];

  if (template.transport !== 'stdio') {
    return { config: template, policy, applied: false, reasons };
  }

  const trustLevel = resolveTrustLevel(template, policy);
  const requireContainerByProfile = policy.profile === 'locked-down';
  const requireContainerByTrust = policy.container.requiredForUntrusted && trustLevel !== 'trusted';
  const requireContainerByService = Boolean((template as any)?.security?.requireContainer);
  const preferContainer = policy.container.prefer && trustLevel !== 'trusted';

  const requireContainer = requireContainerByService || requireContainerByProfile || requireContainerByTrust || preferContainer;

  const requestedSandbox = String(((template as any)?.env as any)?.SANDBOX || '');
  const requestedContainer = requestedSandbox === 'container' || Boolean((template as any)?.container);

  // If the service will run inside a container, do NOT normalize the inner command to a host realpath.
  if (requireContainer || requestedContainer) {
    if (!requireContainer) {
      // Still validate volumes against global allowlist when a container config is provided.
      validateVolumesAllowed(template, policy);
      return { config: template, policy, applied: false, reasons };
    }

    if (requireContainerByService) reasons.push('service.security.requireContainer');
    if (requireContainerByProfile) reasons.push(`sandbox.profile=${policy.profile}`);
    if (requireContainerByTrust) reasons.push(`trustLevel=${trustLevel}`);
    if (preferContainer) reasons.push('sandbox.container.prefer');

    let next: McpServiceConfig = {
      ...template,
      env: { ...(template.env || {}), SANDBOX: 'container' },
      container: { ...((template as any).container || {}) }
    };

    // Default container params
    const container: any = (next as any).container || {};
    if (!container.image) container.image = suggestContainerImage(next);
    if (typeof container.readonlyRootfs !== 'boolean') {
      container.readonlyRootfs = policy.container.defaultReadonlyRootfs;
    }

    const networkPolicy = (next as any)?.security?.networkPolicy as string | undefined;
    if (networkPolicy === 'blocked' || networkPolicy === 'local-only') {
      container.network = 'none';
    } else if (networkPolicy === 'full') {
      // If explicitly allowed, default to bridge unless configured otherwise.
      if (!container.network) container.network = policy.container.defaultNetwork === 'none' ? 'bridge' : policy.container.defaultNetwork;
    } else {
      // inherit
      if (!container.network) {
        // Default to none; trusted services can opt-in to full via security.networkPolicy=full or container.network.
        container.network = 'none';
      }
    }

    (next as any).container = container;

    // Validate volumes against global allowlist (defense-in-depth; adapter will re-check).
    validateVolumesAllowed(next, policy);

    return { config: next, policy, applied: true, reasons };
  }

  // Host execution path: normalize to absolute realpath, then apply portable sandbox (npm/npx).
  const normalized = normalizeStdioExecutableCommand(template, reasons);
  const portable = applyPortableSandboxPolicy(normalized, policy, reasons);
  const applied = portable.applied || normalized !== template;

  return { config: portable.config, policy, applied, reasons };
}
