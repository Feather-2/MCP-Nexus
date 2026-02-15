import { promises as fs } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/** Centralised sandbox paths — single source of truth */
export const SandboxPaths = {
  base: path.resolve(process.cwd(), '../mcp-sandbox'),
  get runtimes() { return path.join(this.base, 'runtimes'); },
  get packages() { return path.join(this.base, 'packages'); },
  get repos() { return path.join(this.base, 'repos'); },
  get nodeDir() { return path.join(this.runtimes, 'nodejs'); },
};

/** Recursively compute directory size in bytes. Returns 0 if dir doesn't exist. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    }
  } catch { /* dir doesn't exist or permission denied */ }
  return total;
}

/** Resolve sandbox Node.js / npm paths, falling back to system node. */
export async function resolveNpm(): Promise<{ nodeBin: string; npmArgs: string[] }> {
  const platform = process.platform;
  const nodeDir = SandboxPaths.nodeDir;
  const nodeBin = platform === 'win32'
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node');

  try { await fs.access(nodeBin); } catch {
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

/** Promisified execFile with timeout and production env. */
export function execInSandbox(cmd: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, env: { ...process.env, NODE_ENV: 'production' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${err.message}\n${stderr}`, { cause: err }));
      else resolve(stdout + stderr);
    });
  });
}
