import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeploymentPolicy, type DeploymentRequest } from '../../security/DeploymentPolicy.js';
import type { Logger } from '../../types/index.js';
import { promises as fs } from 'fs';

// Mock fs.readdir to avoid slow recursive sandbox directory scan
vi.spyOn(fs, 'readdir').mockResolvedValue([] as any);

const mockLogger: Logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => mockLogger, level: 'info',
};

describe('DeploymentPolicy', () => {
  let policy: DeploymentPolicy;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply the mock since clearAllMocks resets it
    vi.spyOn(fs, 'readdir').mockResolvedValue([] as any);
    policy = new DeploymentPolicy(mockLogger);
  });

  describe('check()', () => {
    it('allows a normal package', async () => {
      const req: DeploymentRequest = { source: 'express', type: 'npm', packageName: 'express' };
      const result = await policy.check(req);
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.limits.installTimeoutMs).toBeGreaterThan(0);
    });

    it('blocks packages matching blocklist', async () => {
      const req: DeploymentRequest = { source: 'crypto-miner-pool', type: 'npm', packageName: 'crypto-miner-pool' };
      const result = await policy.check(req);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocklist');
    });

    it('blocks node-gyp-build exactly', async () => {
      const req: DeploymentRequest = { source: 'node-gyp-build', type: 'npm', packageName: 'node-gyp-build' };
      const result = await policy.check(req);
      expect(result.allowed).toBe(false);
    });

    it('blocks malicious packages case-insensitively', async () => {
      const req: DeploymentRequest = { source: 'SomeMaliciousPkg', type: 'npm', packageName: 'SomeMaliciousPkg' };
      const result = await policy.check(req);
      expect(result.allowed).toBe(false);
    });

    it('rejects when concurrent process limit reached', async () => {
      const limited = new DeploymentPolicy(mockLogger, { maxConcurrentProcesses: 1 });
      limited.acquireProcessSlot();
      const req: DeploymentRequest = { source: 'foo', type: 'npm' };
      const result = await limited.check(req);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('concurrent process limit');
      limited.releaseProcessSlot();
    });

    it('enforces scope allowlist for npm packages', async () => {
      const scoped = new DeploymentPolicy(mockLogger, { allowedScopes: ['@myorg'] });
      const req: DeploymentRequest = { source: '@evil/pkg', type: 'npm', packageName: '@evil/pkg' };
      const result = await scoped.check(req);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowlist');
    });

    it('allows scoped packages within allowlist', async () => {
      const scoped = new DeploymentPolicy(mockLogger, { allowedScopes: ['@myorg'] });
      const req: DeploymentRequest = { source: '@myorg/tool', type: 'npm', packageName: '@myorg/tool' };
      const result = await scoped.check(req);
      expect(result.allowed).toBe(true);
    });

    it('skips scope check for github type', async () => {
      const scoped = new DeploymentPolicy(mockLogger, { allowedScopes: ['@myorg'] });
      const req: DeploymentRequest = { source: 'owner/repo', type: 'github', packageName: 'repo' };
      const result = await scoped.check(req);
      expect(result.allowed).toBe(true);
    });

    it('rejects when disk quota exceeded', async () => {
      // Simulate large disk usage by making dirSize return a large number
      const bigPolicy = new DeploymentPolicy(mockLogger, { maxSandboxDiskBytes: 100 });
      // Mock readdir to return a file entry that makes disk usage exceed limit
      vi.spyOn(fs, 'readdir').mockResolvedValue([
        { name: 'big.dat', isDirectory: () => false, isFile: () => true } as any,
      ] as any);
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 200 } as any);

      const req: DeploymentRequest = { source: 'foo', type: 'npm' };
      const result = await bigPolicy.check(req);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disk quota exceeded');
    });
  });

  describe('requestConfirmation()', () => {
    it('returns true when confirmation is not required', async () => {
      const noConfirm = new DeploymentPolicy(mockLogger, { requireUserConfirmation: false });
      const req: DeploymentRequest = { source: 'foo', type: 'npm' };
      expect(await noConfirm.requestConfirmation(req)).toBe(true);
    });

    it('returns false (fail-closed) when no callback set', async () => {
      const req: DeploymentRequest = { source: 'foo', type: 'npm' };
      expect(await policy.requestConfirmation(req)).toBe(false);
    });

    it('delegates to callback and returns its result', async () => {
      const cb = vi.fn().mockResolvedValue(true);
      policy.setConfirmationCallback(cb);
      const req: DeploymentRequest = { source: 'foo', type: 'npm' };
      expect(await policy.requestConfirmation(req)).toBe(true);
      expect(cb).toHaveBeenCalledWith(req);
    });

    it('returns false when callback throws', async () => {
      policy.setConfirmationCallback(() => { throw new Error('boom'); });
      const req: DeploymentRequest = { source: 'foo', type: 'npm' };
      expect(await policy.requestConfirmation(req)).toBe(false);
    });
  });

  describe('process slots', () => {
    it('acquires and releases slots correctly', () => {
      expect(policy.getActiveProcessCount()).toBe(0);
      expect(policy.acquireProcessSlot()).toBe(true);
      expect(policy.getActiveProcessCount()).toBe(1);
      policy.releaseProcessSlot();
      expect(policy.getActiveProcessCount()).toBe(0);
    });

    it('refuses slot when at limit', () => {
      const limited = new DeploymentPolicy(mockLogger, { maxConcurrentProcesses: 1 });
      expect(limited.acquireProcessSlot()).toBe(true);
      expect(limited.acquireProcessSlot()).toBe(false);
      limited.releaseProcessSlot();
      expect(limited.acquireProcessSlot()).toBe(true);
    });

    it('never goes below zero on release', () => {
      policy.releaseProcessSlot();
      policy.releaseProcessSlot();
      expect(policy.getActiveProcessCount()).toBe(0);
    });
  });

  describe('getLimits()', () => {
    it('returns default limits', () => {
      const limits = policy.getLimits();
      expect(limits.maxSandboxDiskBytes).toBe(2 * 1024 * 1024 * 1024);
      expect(limits.maxPackageSizeBytes).toBe(200 * 1024 * 1024);
      expect(limits.maxConcurrentProcesses).toBe(5);
    });

    it('merges overrides', () => {
      const custom = new DeploymentPolicy(mockLogger, { maxConcurrentProcesses: 10 });
      expect(custom.getLimits().maxConcurrentProcesses).toBe(10);
      expect(custom.getLimits().maxSandboxDiskBytes).toBe(2 * 1024 * 1024 * 1024);
    });
  });
});
