import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import { GitHubPackageResolver } from '../../gateway/GitHubPackageResolver.js';
import { DeploymentPolicy } from '../../security/DeploymentPolicy.js';
import type { Logger } from '../../types/index.js';

// Mock fs.readdir to avoid slow recursive sandbox disk scan in DeploymentPolicy
vi.spyOn(fs, 'readdir').mockResolvedValue([] as any);

const mockLogger: Logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => mockLogger, level: 'info',
};

// Tests focus on policy gates and URL parsing heuristics.
// Actual git clone/npm install operations are not tested here.
describe('GitHubPackageResolver', () => {
  describe('policy gate — github path', () => {
    it('rejects blocked github repos via policy', async () => {
      const policy = new DeploymentPolicy(mockLogger, {
        blockedPackages: ['^malicious-repo$'],
      });
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      await expect(resolver.resolve('owner/malicious-repo'))
        .rejects.toThrow('deployment policy denied');
    });

    it('rejects when user denies confirmation for github', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      // No callback = fail-closed
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      await expect(resolver.resolve('owner/repo'))
        .rejects.toThrow('user denied deployment');
    });

    it('rejects when concurrent limit reached', async () => {
      const policy = new DeploymentPolicy(mockLogger, { maxConcurrentProcesses: 0 });
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      await expect(resolver.resolve('owner/repo'))
        .rejects.toThrow('concurrent process limit');
    });
  });

  describe('policy gate — npm path', () => {
    it('rejects blocked npm packages', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      // npm path, blocked by default blocklist
      await expect(resolver.resolve('crypto-miner-pool'))
        .rejects.toThrow('policy denied');
    });

    it('rejects npm install when no confirmation callback (fail-closed)', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      // @scope/pkg starts with @ so not treated as github owner/repo
      await expect(resolver.resolve('@modelcontextprotocol/sdk'))
        .rejects.toThrow('user denied');
    });
  });

  describe('URL parsing heuristic', () => {
    it('recognizes https github URL (fails at confirmation)', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      await expect(resolver.resolve('https://github.com/modelcontextprotocol/servers'))
        .rejects.toThrow('user denied deployment');
    });

    it('recognizes owner/repo shorthand (fails at confirmation)', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      await expect(resolver.resolve('modelcontextprotocol/servers'))
        .rejects.toThrow('user denied deployment');
    });

    it('recognizes github URL with .git suffix', async () => {
      const policy = new DeploymentPolicy(mockLogger);
      const resolver = new GitHubPackageResolver(mockLogger, policy);

      await expect(resolver.resolve('https://github.com/owner/repo.git'))
        .rejects.toThrow('user denied deployment');
    });
  });
});
