import { promises as fs } from 'fs';
import * as path from 'path';
import type { Logger } from '../types/index.js';
import { DeploymentPolicy, type DeploymentRequest } from '../security/DeploymentPolicy.js';
import { SandboxPaths, resolveNpm, execInSandbox } from '../utils/SandboxUtils.js';

export interface PackageInstallResult {
  success: boolean;
  packageName: string;
  installDir: string;
  error?: string;
}

export class SandboxPackageInstaller {
  constructor(
    private readonly logger: Logger,
    private readonly policy?: DeploymentPolicy,
  ) {}

  async install(packageSpec: string, opts?: { cwd?: string; timeout?: number }): Promise<PackageInstallResult> {
    // Policy check: validate before any I/O
    if (this.policy) {
      const request: DeploymentRequest = { source: packageSpec, type: 'npm', packageName: packageSpec };
      const check = await this.policy.check(request);
      if (!check.allowed) {
        return { success: false, packageName: packageSpec, installDir: '', error: `policy denied: ${check.reason}` };
      }
      if (check.requiresConfirmation) {
        const confirmed = await this.policy.requestConfirmation(request);
        if (!confirmed) {
          return { success: false, packageName: packageSpec, installDir: '', error: 'user denied deployment' };
        }
      }
    }

    const limits = this.policy?.getLimits();
    const timeout = opts?.timeout ?? limits?.installTimeoutMs ?? 120_000;
    const installDir = opts?.cwd ?? SandboxPaths.packages;

    this.logger.info('installing package in sandbox', { packageSpec, installDir });

    const { nodeBin, npmArgs } = await resolveNpm();

    await fs.mkdir(installDir, { recursive: true });

    // Ensure package.json exists so npm install works
    const pkgJsonPath = path.join(installDir, 'package.json');
    try {
      await fs.access(pkgJsonPath);
    } catch {
      await fs.writeFile(pkgJsonPath, JSON.stringify({ name: 'mcp-sandbox-packages', private: true }, null, 2));
    }

    const args = [...npmArgs, 'install', '--no-audit', '--no-fund', '--save', packageSpec];

    try {
      const output = await execInSandbox(nodeBin, args, installDir, timeout);
      this.logger.info('package installed successfully', { packageSpec });

      // Detect the installed package directory
      const pkgName = this.extractPackageName(packageSpec);
      const pkgDir = path.join(installDir, 'node_modules', pkgName);

      return { success: true, packageName: pkgName, installDir: pkgDir };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('package installation failed', { packageSpec, err });
      return { success: false, packageName: packageSpec, installDir, error: msg };
    }
  }

  async detectEntryPoint(pkgDir: string): Promise<{ command: string; args: string[] } | null> {
    try {
      const raw = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);

      // Check bin field
      if (pkg.bin) {
        const binName = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0] as string;
        if (binName) {
          return { command: 'node', args: [path.resolve(pkgDir, binName)] };
        }
      }

      // Check main field
      if (pkg.main) {
        return { command: 'node', args: [path.resolve(pkgDir, pkg.main)] };
      }

      // Check for common entry files
      for (const candidate of ['dist/index.js', 'build/index.js', 'index.js', 'src/index.js']) {
        try {
          await fs.access(path.join(pkgDir, candidate));
          return { command: 'node', args: [path.resolve(pkgDir, candidate)] };
        } catch { /* continue */ }
      }

      return null;
    } catch {
      return null;
    }
  }

  async isInstalled(packageName: string): Promise<boolean> {
    try {
      await fs.access(path.join(SandboxPaths.packages, 'node_modules', packageName));
      return true;
    } catch {
      return false;
    }
  }

  private extractPackageName(spec: string): string {
    // Handle scoped packages: @scope/name@version → @scope/name
    // Handle plain: name@version → name
    // Handle GitHub: owner/repo → owner/repo (will use repo name)
    const atVersionIdx = spec.lastIndexOf('@');
    if (atVersionIdx > 0 && !spec.startsWith('@')) {
      return spec.slice(0, atVersionIdx);
    }
    if (spec.startsWith('@') && atVersionIdx > 0) {
      const secondAt = spec.indexOf('@', 1);
      if (secondAt > 0) return spec.slice(0, secondAt);
    }
    return spec;
  }
}
