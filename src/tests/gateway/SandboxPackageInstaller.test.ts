import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { SandboxPackageInstaller } from '../../gateway/SandboxPackageInstaller.js';
import { DeploymentPolicy } from '../../security/DeploymentPolicy.js';
import type { Logger } from '../../types/index.js';

// Mock fs.readdir to avoid slow recursive sandbox disk scan in DeploymentPolicy
vi.spyOn(fs, 'readdir').mockResolvedValue([] as any);

const mockLogger: Logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

// Only test the policy gate logic — actual npm install requires sandbox runtime
describe('SandboxPackageInstaller', () => {
  describe('policy gate', () => {
    it('rejects blocked packages via policy', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const installer = new SandboxPackageInstaller(mockLogger, policy);

      const result = await installer.install('crypto-miner-pool');
      expect(result.success).toBe(false);
      expect(result.error).toContain('policy denied');
      expect(result.error).toContain('blocklist');
    });

    it('rejects when user denies confirmation (fail-closed)', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      // No confirmation callback set => fail-closed
      const installer = new SandboxPackageInstaller(mockLogger, policy);

      const result = await installer.install('express');
      expect(result.success).toBe(false);
      expect(result.error).toContain('user denied');
    });

    it('rejects node-gyp-build via blocklist', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const installer = new SandboxPackageInstaller(mockLogger, policy);

      const result = await installer.install('node-gyp-build');
      expect(result.success).toBe(false);
      expect(result.error).toContain('blocklist');
    });
  });

  describe('detectEntryPoint()', () => {
    it('returns null for non-existent directory', async () => {
      const installer = new SandboxPackageInstaller(mockLogger);
      const entry = await installer.detectEntryPoint('/tmp/nonexistent-dir-xyzzy');
      expect(entry).toBeNull();
    });
  });

  describe('isInstalled()', () => {
    it('returns false for non-existent package', async () => {
      const installer = new SandboxPackageInstaller(mockLogger);
      const installed = await installer.isInstalled('definitely-not-installed-xyzzy');
      expect(installed).toBe(false);
    });
  });
});
