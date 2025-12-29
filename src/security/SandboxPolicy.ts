import path from 'path';
import type { GatewayConfig, McpServiceConfig } from '../types/index.js';

export type NormalizedSecurityProfile = 'dev' | 'default' | 'locked-down';
export type NormalizedContainerNetwork = 'none' | 'bridge';

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

export function normalizeSandboxPolicy(gatewayConfig?: GatewayConfig): NormalizedSandboxPolicy {
  const sandbox: any = (gatewayConfig as any)?.sandbox || {};

  const profile: NormalizedSecurityProfile =
    sandbox.profile === 'locked-down' || sandbox.profile === 'dev' || sandbox.profile === 'default'
      ? sandbox.profile
      : 'default';

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
    const ok = policy.container.allowedVolumeRoots.some((root) => hostResolved.startsWith(root));
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

  if (!requireContainer) {
    return { config: template, policy, applied: false, reasons };
  }

  if (requireContainerByService) reasons.push('service.security.requireContainer');
  if (requireContainerByProfile) reasons.push(`sandbox.profile=${policy.profile}`);
  if (requireContainerByTrust) reasons.push(`trustLevel=${trustLevel}`);
  if (preferContainer) reasons.push('sandbox.container.prefer');

  const next: McpServiceConfig = {
    ...template,
    env: { ...(template.env || {}), SANDBOX: 'container' },
    container: { ...((template as any).container || {}) }
  };

  // Default container params
  const container: any = (next as any).container || {};
  if (!container.image) container.image = suggestContainerImage(template);
  if (typeof container.readonlyRootfs !== 'boolean') {
    container.readonlyRootfs = policy.container.defaultReadonlyRootfs;
  }

  const networkPolicy = (template as any)?.security?.networkPolicy as string | undefined;
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
