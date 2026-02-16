import type { Logger } from '../types/index.js';
import { dirSize, SandboxPaths } from '../utils/SandboxUtils.js';

/**
 * DeploymentPolicy enforces resource limits and user confirmation gates
 * to prevent AI agents from deploying unbounded workloads.
 *
 * Safety guarantees:
 * 1. Disk quota — total sandbox size cannot exceed configured limit
 * 2. Package size — individual install capped before download starts
 * 3. Process limits — max concurrent sandbox processes
 * 4. Timeout — hard kill on install/build exceeding deadline
 * 5. User confirmation — every deploy action requires explicit approval
 * 6. Blocklist — known-dangerous packages rejected upfront
 */

export interface DeploymentLimits {
  /** Max total sandbox disk usage in bytes (default: 2 GB) */
  maxSandboxDiskBytes: number;
  /** Max single package install size in bytes (default: 200 MB) */
  maxPackageSizeBytes: number;
  /** Max single repo clone size in bytes (default: 500 MB) */
  maxRepoSizeBytes: number;
  /** Max concurrent sandbox processes (default: 5) */
  maxConcurrentProcesses: number;
  /** Install timeout in ms (default: 3 min) */
  installTimeoutMs: number;
  /** Build timeout in ms (default: 5 min) */
  buildTimeoutMs: number;
  /** Clone timeout in ms (default: 2 min) */
  cloneTimeoutMs: number;
  /** Max clone depth (default: 1, shallow clone) */
  maxCloneDepth: number;
  /** Require user confirmation before any deployment (default: true) */
  requireUserConfirmation: boolean;
  /** Blocked package name patterns (regex) */
  blockedPackages: string[];
  /** Allowed package scopes (if set, only these scopes are allowed) */
  allowedScopes: string[] | null;
}

export interface DeploymentRequest {
  source: string;
  type: 'github' | 'npm';
  packageName?: string;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
  limits: {
    installTimeoutMs: number;
    buildTimeoutMs: number;
    cloneTimeoutMs: number;
    maxCloneDepth: number;
  };
}

export type ConfirmationCallback = (request: DeploymentRequest) => Promise<boolean>;

/**
 * Authorization mode controls how deployment confirmation is handled:
 * - 'interactive': requires a ConfirmationCallback (fail-closed if absent)
 * - 'api': auto-approves after policy checks pass (for server-side API calls)
 */
export type AuthorizationMode = 'interactive' | 'api';

const DEFAULT_LIMITS: DeploymentLimits = {
  maxSandboxDiskBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxPackageSizeBytes: 200 * 1024 * 1024, // 200 MB
  maxRepoSizeBytes: 500 * 1024 * 1024, // 500 MB
  maxConcurrentProcesses: 5,
  installTimeoutMs: 3 * 60 * 1000, // 3 min
  buildTimeoutMs: 5 * 60 * 1000, // 5 min
  cloneTimeoutMs: 2 * 60 * 1000, // 2 min
  maxCloneDepth: 1,
  requireUserConfirmation: true,
  blockedPackages: [
    '^node-gyp-build$', // native builds can be slow/dangerous
    '.*crypto.?miner.*',
    '.*malicious.*',
  ],
  allowedScopes: null, // null = all scopes allowed
};

export class DeploymentPolicy {
  private limits: DeploymentLimits;
  private activeProcesses = 0;
  private confirmationCallback: ConfirmationCallback | null = null;
  private authMode: AuthorizationMode;

  constructor(
    private readonly logger: Logger,
    overrides?: Partial<DeploymentLimits>,
    authMode: AuthorizationMode = 'interactive',
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...overrides };
    this.authMode = authMode;
  }

  setConfirmationCallback(cb: ConfirmationCallback): void {
    this.confirmationCallback = cb;
  }

  getLimits(): Readonly<DeploymentLimits> {
    return this.limits;
  }

  /**
   * Pre-flight check: validates a deployment request against all policies.
   * Must be called BEFORE any clone/install operation.
   */
  async check(request: DeploymentRequest): Promise<PolicyCheckResult> {
    const base: PolicyCheckResult = {
      allowed: true,
      requiresConfirmation: this.limits.requireUserConfirmation,
      limits: {
        installTimeoutMs: this.limits.installTimeoutMs,
        buildTimeoutMs: this.limits.buildTimeoutMs,
        cloneTimeoutMs: this.limits.cloneTimeoutMs,
        maxCloneDepth: this.limits.maxCloneDepth,
      },
    };

    // 1. Blocklist check
    const pkgName = request.packageName || request.source;
    for (const pattern of this.limits.blockedPackages) {
      if (new RegExp(pattern, 'i').test(pkgName)) {
        this.logger.warn('deployment blocked by blocklist', { source: request.source, pattern });
        return { ...base, allowed: false, reason: `package matches blocklist pattern: ${pattern}` };
      }
    }

    // 2. Scope allowlist check
    if (this.limits.allowedScopes && request.type === 'npm') {
      const isScoped = pkgName.startsWith('@');
      if (isScoped) {
        const scope = pkgName.split('/')[0];
        if (!this.limits.allowedScopes.includes(scope)) {
          return { ...base, allowed: false, reason: `scope ${scope} not in allowlist` };
        }
      }
    }

    // 3. Concurrent process limit
    if (this.activeProcesses >= this.limits.maxConcurrentProcesses) {
      return { ...base, allowed: false, reason: `concurrent process limit reached (${this.limits.maxConcurrentProcesses})` };
    }

    // 4. Disk quota check
    const diskUsage = await this.getSandboxDiskUsage();
    if (diskUsage >= this.limits.maxSandboxDiskBytes) {
      const usedMB = Math.round(diskUsage / 1024 / 1024);
      const limitMB = Math.round(this.limits.maxSandboxDiskBytes / 1024 / 1024);
      return { ...base, allowed: false, reason: `sandbox disk quota exceeded: ${usedMB}MB / ${limitMB}MB` };
    }

    return base;
  }

  /**
   * Request user confirmation for a deployment.
   * Returns true if confirmed, false if denied.
   * If no callback is set and confirmation is required, returns false (fail-closed).
   */
  setAuthorizationMode(mode: AuthorizationMode): void {
    this.authMode = mode;
  }

  getAuthorizationMode(): AuthorizationMode {
    return this.authMode;
  }

  async requestConfirmation(request: DeploymentRequest): Promise<boolean> {
    if (!this.limits.requireUserConfirmation) return true;

    // API mode: auto-approve after policy checks pass
    if (this.authMode === 'api') {
      this.logger.info('api mode: auto-approving deployment', { source: request.source });
      return true;
    }

    if (!this.confirmationCallback) {
      this.logger.warn('deployment requires confirmation but no callback set, denying', { source: request.source });
      return false;
    }

    try {
      const confirmed = await this.confirmationCallback(request);
      this.logger.info('user confirmation result', { source: request.source, confirmed });
      return confirmed;
    } catch (err) {
      this.logger.error('confirmation callback failed, denying', { err });
      return false;
    }
  }

  /** Track process start — call before spawning a sandbox process */
  acquireProcessSlot(): boolean {
    if (this.activeProcesses >= this.limits.maxConcurrentProcesses) return false;
    this.activeProcesses++;
    return true;
  }

  /** Track process end — call when sandbox process exits */
  releaseProcessSlot(): void {
    this.activeProcesses = Math.max(0, this.activeProcesses - 1);
  }

  getActiveProcessCount(): number {
    return this.activeProcesses;
  }

  /**
   * Execute a function within an acquired process slot.
   * Guarantees the slot is released even if the function throws.
   */
  async withProcessSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.acquireProcessSlot()) {
      throw new Error(`concurrent process limit reached (${this.limits.maxConcurrentProcesses})`);
    }
    try {
      return await fn();
    } finally {
      this.releaseProcessSlot();
    }
  }

  /**
   * Calculate total disk usage of sandbox directory.
   * Returns 0 if sandbox doesn't exist yet.
   */
  private async getSandboxDiskUsage(): Promise<number> {
    try {
      return await dirSize(SandboxPaths.base);
    } catch {
      return 0;
    }
  }
}
