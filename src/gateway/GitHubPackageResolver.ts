import { promises as fs } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { Logger } from 'pino';
import { SandboxPackageInstaller } from './SandboxPackageInstaller.js';
import { DeploymentPolicy, type DeploymentRequest } from '../security/DeploymentPolicy.js';

export interface ResolvedPackage {
  name: string;
  templateName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: 'stdio' | 'http';
  source: 'github' | 'npm';
  installDir: string;
}

const CLONE_BASE = path.resolve(process.cwd(), '../mcp-sandbox/repos');

export class GitHubPackageResolver {
  private readonly installer: SandboxPackageInstaller;

  constructor(
    private readonly logger: Logger,
    private readonly policy?: DeploymentPolicy,
  ) {
    this.installer = new SandboxPackageInstaller(logger, policy);
  }

  /**
   * Resolve a source (GitHub URL or npm package name) into a deployable template config.
   * All operations are gated by DeploymentPolicy (resource limits + user confirmation).
   */
  async resolve(source: string): Promise<ResolvedPackage> {
    const ghInfo = this.parseGitHub(source);
    if (ghInfo) {
      return this.resolveFromGitHub(ghInfo.owner, ghInfo.repo, ghInfo.ref);
    }
    return this.resolveFromNpm(source);
  }

  private async resolveFromGitHub(owner: string, repo: string, ref?: string): Promise<ResolvedPackage> {
    // Policy gate: check + confirm before any I/O
    if (this.policy) {
      const request: DeploymentRequest = { source: `${owner}/${repo}`, type: 'github', packageName: repo };
      const check = await this.policy.check(request);
      if (!check.allowed) {
        throw new Error(`deployment policy denied: ${check.reason}`);
      }
      if (check.requiresConfirmation) {
        const confirmed = await this.policy.requestConfirmation(request);
        if (!confirmed) {
          throw new Error('user denied deployment');
        }
      }
    }

    const limits = this.policy?.getLimits();
    const cloneDir = path.join(CLONE_BASE, owner, repo);
    const url = `https://github.com/${owner}/${repo}.git`;
    const cloneDepth = limits?.maxCloneDepth ?? 1;
    const cloneTimeout = limits?.cloneTimeoutMs ?? 120_000;
    const installTimeout = limits?.installTimeoutMs ?? 180_000;
    const buildTimeout = limits?.buildTimeoutMs ?? 180_000;

    this.logger.info({ owner, repo, ref, cloneDepth }, 'resolving GitHub package');

    // Clone or pull
    try {
      await fs.access(path.join(cloneDir, '.git'));
      this.logger.info({ cloneDir }, 'repo exists, pulling latest');
      await this.exec('git', ['pull', '--ff-only'], cloneDir, cloneTimeout);
    } catch {
      this.logger.info({ url, cloneDir }, 'cloning repository');
      await fs.mkdir(path.dirname(cloneDir), { recursive: true });
      const cloneArgs = ['clone', '--depth', String(cloneDepth), url, cloneDir];
      if (ref) cloneArgs.splice(3, 0, '--branch', ref);
      await this.exec('git', cloneArgs, process.cwd(), cloneTimeout);
    }

    // Verify repo size against policy
    if (this.policy) {
      const repoSize = await this.dirSize(cloneDir);
      const maxRepoSize = limits?.maxRepoSizeBytes ?? 500 * 1024 * 1024;
      if (repoSize > maxRepoSize) {
        const sizeMB = Math.round(repoSize / 1024 / 1024);
        const limitMB = Math.round(maxRepoSize / 1024 / 1024);
        // Clean up oversized clone
        await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`repo size ${sizeMB}MB exceeds limit ${limitMB}MB`);
      }
    }

    // Read package.json
    const pkgJson = await this.readPackageJson(cloneDir);
    const templateName = pkgJson?.name?.replace(/[\/@ ]/g, '-').replace(/^-+|-+$/g, '') || repo;

    // Install dependencies
    const { nodeBin, npmArgs } = await this.resolveNpm();
    const installArgs = [...npmArgs, 'install', '--production', '--no-audit', '--no-fund'];
    this.logger.info({ cloneDir }, 'installing dependencies');
    await this.exec(nodeBin, installArgs, cloneDir, installTimeout);

    // Build if build script exists
    if (pkgJson?.scripts?.build) {
      this.logger.info({ cloneDir }, 'running build');
      const buildArgs = [...npmArgs, 'run', 'build'];
      try {
        await this.exec(nodeBin, buildArgs, cloneDir, buildTimeout);
      } catch (err) {
        this.logger.warn({ err }, 'build failed, trying without build step');
      }
    }

    // Detect entry point
    const entry = await this.installer.detectEntryPoint(cloneDir);
    if (!entry) {
      throw new Error(`cannot detect entry point for ${owner}/${repo}, no bin/main/index.js found`);
    }

    // Detect transport
    const transport = await this.detectTransport(cloneDir, pkgJson);

    return {
      name: pkgJson?.name || repo,
      templateName,
      command: entry.command,
      args: entry.args,
      env: { SANDBOX: 'portable' },
      transport,
      source: 'github',
      installDir: cloneDir,
    };
  }

  private async resolveFromNpm(packageSpec: string): Promise<ResolvedPackage> {
    this.logger.info({ packageSpec }, 'resolving npm package');

    const result = await this.installer.install(packageSpec);
    if (!result.success) {
      throw new Error(`npm install failed: ${result.error}`);
    }

    const entry = await this.installer.detectEntryPoint(result.installDir);
    if (!entry) {
      throw new Error(`cannot detect entry point for ${packageSpec}`);
    }

    const pkgJson = await this.readPackageJson(result.installDir);
    const templateName = result.packageName.replace(/[\/@ ]/g, '-').replace(/^-+|-+$/g, '');
    const transport = await this.detectTransport(result.installDir, pkgJson);

    return {
      name: result.packageName,
      templateName,
      command: entry.command,
      args: entry.args,
      env: { SANDBOX: 'portable' },
      transport,
      source: 'npm',
      installDir: result.installDir,
    };
  }

  private parseGitHub(source: string): { owner: string; repo: string; ref?: string } | null {
    // https://github.com/owner/repo(.git)?(#ref)?
    const httpsMatch = source.match(/github\.com\/([\w.-]+)\/(\w[\w.-]*)(?:\.git)?(?:#(.+))?/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2], ref: httpsMatch[3] };

    // owner/repo shorthand (must have exactly one slash, no dots/colons)
    if (/^[\w.-]+\/[\w.-]+$/.test(source) && !source.startsWith('@')) {
      return { owner: source.split('/')[0], repo: source.split('/')[1] };
    }

    return null;
  }

  private async detectTransport(dir: string, pkgJson: Record<string, unknown> | null): Promise<'stdio' | 'http'> {
    // Heuristic: if package.json has keywords or dependencies suggesting HTTP transport
    const deps = { ...((pkgJson?.dependencies || {}) as Record<string, string>), ...((pkgJson?.devDependencies || {}) as Record<string, string>) };
    const keywords = (pkgJson?.keywords || []) as string[];

    if (keywords.some(k => k.includes('http') || k.includes('sse'))) return 'http';
    if (deps['express'] || deps['fastify'] || deps['hono']) return 'http';

    // Check source files for http indicators
    try {
      const files = await fs.readdir(path.join(dir, 'src')).catch(() => fs.readdir(dir));
      for (const f of files.slice(0, 10)) {
        if (!f.endsWith('.ts') && !f.endsWith('.js')) continue;
        const content = await fs.readFile(path.join(dir, f), 'utf-8').catch(() => '');
        if (content.includes('SSEServerTransport') || content.includes('StreamableHTTPServerTransport')) {
          return 'http';
        }
      }
    } catch { /* ignore */ }

    return 'stdio';
  }

  private async readPackageJson(dir: string): Promise<Record<string, any> | null> {
    try {
      const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async resolveNpm(): Promise<{ nodeBin: string; npmArgs: string[] }> {
    const platform = process.platform;
    const nodeDir = path.join(path.resolve(process.cwd(), '../mcp-sandbox/runtimes'), 'nodejs');
    const nodeBin = platform === 'win32'
      ? path.join(nodeDir, 'node.exe')
      : path.join(nodeDir, 'bin', 'node');

    try { await fs.access(nodeBin); } catch {
      // Fall back to system node
      return { nodeBin: 'node', npmArgs: [path.join(process.execPath, '..', 'npm')] };
    }

    const npmScript = platform === 'win32'
      ? path.join(nodeDir, 'npm.cmd')
      : path.join(nodeDir, 'bin', 'npm');

    try {
      await fs.access(npmScript);
      return { nodeBin: npmScript, npmArgs: [] };
    } catch {
      const npmCliJs = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      return { nodeBin, npmArgs: [npmCliJs] };
    }
  }

  private exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, timeout, env: { ...process.env, NODE_ENV: 'production' } }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${err.message}\n${stderr}`, { cause: err }));
        else resolve(stdout + stderr);
      });
    });
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await this.dirSize(full);
        else if (entry.isFile()) total += (await fs.stat(full)).size;
      }
    } catch { /* ignore */ }
    return total;
  }
}
