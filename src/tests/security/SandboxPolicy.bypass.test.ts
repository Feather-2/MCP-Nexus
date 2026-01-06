import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { applyGatewaySandboxPolicy } from '../../security/SandboxPolicy.js';
import { ExecutableResolver } from '../../security/ExecutableResolver.js';
import { ProtocolAdaptersImpl } from '../../adapters/ProtocolAdaptersImpl.js';
import { ContainerTransportAdapter } from '../../adapters/ContainerTransportAdapter.js';
import type { GatewayConfig, Logger, McpServiceConfig } from '../../types/index.js';

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o755);
  }
}

async function safeRm(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe('SandboxPolicy bypass hardening', () => {
  it('ignores template PATH when resolving command (fake npx in PATH prefix)', async () => {
    const fakeBin = await makeTempDir('mcp-fakebin-');
    try {
      const fakeName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const fakeNpx = path.join(fakeBin, fakeName);
      await writeExecutable(fakeNpx, process.platform === 'win32' ? '@echo off\r\necho fake\r\n' : '#!/bin/sh\necho fake\n');

      const tpl: McpServiceConfig = {
        name: 'svc',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['--version'],
        env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` },
        timeout: 1000,
        retries: 0
      };

      const res = applyGatewaySandboxPolicy(tpl, undefined);
      const cmd = String((res.config as any).command || '');
      expect(path.isAbsolute(cmd)).toBe(true);
      expect(cmd.startsWith(fakeBin)).toBe(false);
      // Ensure portable policy still applies (npx detection should use the normalized wrapper path, not the realpath target).
      expect((res.config.env as any)?.SANDBOX).toBe('portable');
      expect(res.reasons.join('|')).toContain('sandbox.exec.normalized');
    } finally {
      await safeRm(fakeBin);
    }
  });

  it('blocks symlink indirection to a different executable (realpath escapes allowed root)', async () => {
    const allowedRoot = await makeTempDir('mcp-allowed-');
    const outsideRoot = await makeTempDir('mcp-outside-');
    try {
      const exeName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const target = path.join(outsideRoot, exeName);
      await writeExecutable(target, process.platform === 'win32' ? '@echo off\r\necho target\r\n' : '#!/bin/sh\necho target\n');

      const link = path.join(allowedRoot, exeName);
      try {
        await fs.symlink(target, link, process.platform === 'win32' ? 'file' : undefined);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/operation not permitted|privilege|not supported|EPERM|EACCES/i.test(msg)) {
          // Symlink support can be restricted on Windows environments (CI / developer mode).
          return;
        }
        throw e;
      }

      const resolver = new ExecutableResolver({
        cwd: allowedRoot,
        pathEnv: allowedRoot,
        allowedRoots: [allowedRoot]
      });
      expect(() => resolver.resolveOrThrow('npx')).toThrow(/outside allowed roots/i);
    } finally {
      await safeRm(allowedRoot);
      await safeRm(outsideRoot);
    }
  });

  it('handles Windows/Unix path variants when checking root containment', () => {
    // POSIX
    expect(ExecutableResolver.isWithinAllowedRoot('/data/sub', '/data')).toBe(true);
    expect(ExecutableResolver.isWithinAllowedRoot('/data2', '/data')).toBe(false);

    // Windows
    expect(ExecutableResolver.isWithinAllowedRoot('C:\\data\\sub', 'C:\\data')).toBe(true);
    expect(ExecutableResolver.isWithinAllowedRoot('C:\\data2', 'C:\\data')).toBe(false);
    expect(ExecutableResolver.isWithinAllowedRoot('c:\\DATA\\sub', 'C:\\data')).toBe(true);
  });

  it('resolves path-like commands to absolute paths (./tool → /abs/tool)', async () => {
    const dir = await makeTempDir('mcp-exe-');
    try {
      const toolName = process.platform === 'win32' ? 'tool.cmd' : 'tool';
      const tool = path.join(dir, toolName);
      await writeExecutable(tool, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n');

      const resolver = new ExecutableResolver({
        cwd: dir,
        pathEnv: '',
        allowedRoots: [dir],
        platform: process.platform === 'win32' ? 'win32' : 'linux'
      });

      const resolved = resolver.resolveOrThrow(process.platform === 'win32' ? '.\\tool.cmd' : './tool');
      expect(resolved.resolvedPath).toBe(tool);
      expect(resolved.realPath).toBe(tool);
    } finally {
      await safeRm(dir);
    }
  });

  it('supports Windows PATHEXT expansion when platform=win32', async () => {
    const dir = await makeTempDir('mcp-pathext-');
    try {
      const cmd = path.join(dir, 'hello.cmd');
      await writeExecutable(cmd, '@echo off\r\necho hello\r\n');

      const resolver = new ExecutableResolver({
        cwd: dir,
        pathEnv: dir,
        allowedRoots: [dir],
        platform: 'win32',
        pathext: '.CMD'
      });

      const resolved = resolver.resolveOrThrow('hello');
      expect(resolved.resolvedPath).toBe(cmd);
    } finally {
      await safeRm(dir);
    }
  });

  it('throws a clear error for empty or missing commands', async () => {
    const dir = await makeTempDir('mcp-miss-');
    try {
      const resolver = new ExecutableResolver({ cwd: dir, pathEnv: dir, allowedRoots: [dir] });
      expect(() => resolver.resolveOrThrow('')).toThrow(/empty command/i);
      expect(() => resolver.resolveOrThrow('does-not-exist')).toThrow(/command not found/i);
    } finally {
      await safeRm(dir);
    }
  });

  it('prevents volume allowlist prefix collision via path.relative semantics', async () => {
    const root = await makeTempDir('mcp-vols-');
    try {
      const allowed = path.join(root, 'allowed');
      const collide = path.join(root, 'allowed2');
      const okChild = path.join(allowed, 'child');
      await fs.mkdir(okChild, { recursive: true });
      await fs.mkdir(collide, { recursive: true });

      const gw: GatewayConfig = {
        port: 0,
        host: '127.0.0.1',
        authMode: 'local-trusted',
        routingStrategy: 'performance',
        loadBalancingStrategy: 'performance-based',
        maxConcurrentServices: 1,
        requestTimeout: 1000,
        enableMetrics: false,
        enableHealthChecks: false,
        healthCheckInterval: 1000,
        maxRetries: 0,
        enableCors: false,
        corsOrigins: [],
        maxRequestSize: 1024,
        metricsRetentionDays: 1,
        rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
        logLevel: 'info',
        sandbox: { profile: 'locked-down', container: { allowedVolumeRoots: [allowed] } } as any
      };

      const tpl: McpServiceConfig = {
        name: 'svc',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'node',
        args: ['-v'],
        container: {
          image: 'node:20-alpine',
          volumes: [{ hostPath: collide, containerPath: '/data', readOnly: true }]
        } as any,
        timeout: 1000,
        retries: 0
      };

      expect(() => applyGatewaySandboxPolicy(tpl, gw)).toThrow(/Volume hostPath not allowed/i);

      const okTpl: McpServiceConfig = {
        ...tpl,
        container: {
          image: 'node:20-alpine',
          volumes: [{ hostPath: okChild, containerPath: '/data', readOnly: true }]
        } as any
      };
      expect(() => applyGatewaySandboxPolicy(okTpl, gw)).not.toThrow();
    } finally {
      await safeRm(root);
    }
  });

  it('applies container networkPolicy defaults for full/blocked', () => {
    const gw: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { profile: 'locked-down', container: { defaultNetwork: 'none' } } as any
    };

    const base: McpServiceConfig = {
      name: 'svc',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'node',
      args: ['-v'],
      timeout: 1000,
      retries: 0
    };

    const full = applyGatewaySandboxPolicy({ ...base, security: { trustLevel: 'trusted', networkPolicy: 'full', requireContainer: false } } as any, gw);
    expect((full.config as any).container?.network).toBe('bridge');

    const blocked = applyGatewaySandboxPolicy({ ...base, security: { trustLevel: 'trusted', networkPolicy: 'blocked', requireContainer: false } } as any, gw);
    expect((blocked.config as any).container?.network).toBe('none');
  });

  it('validates volumes even when container is explicitly requested (SANDBOX=container)', async () => {
    const root = await makeTempDir('mcp-vols2-');
    try {
      const gw: GatewayConfig = {
        port: 0,
        host: '127.0.0.1',
        authMode: 'local-trusted',
        routingStrategy: 'performance',
        loadBalancingStrategy: 'performance-based',
        maxConcurrentServices: 1,
        requestTimeout: 1000,
        enableMetrics: false,
        enableHealthChecks: false,
        healthCheckInterval: 1000,
        maxRetries: 0,
        enableCors: false,
        corsOrigins: [],
        maxRequestSize: 1024,
        metricsRetentionDays: 1,
        rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
        logLevel: 'info',
        sandbox: { container: { allowedVolumeRoots: [path.join(root, 'allowed')] } } as any
      };

      const disallowed = path.join(root, 'disallowed');
      await fs.mkdir(disallowed, { recursive: true });

      const tpl: McpServiceConfig = {
        name: 'svc',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'node',
        args: ['-v'],
        env: { SANDBOX: 'container' },
        container: { image: 'node:20-alpine', volumes: [{ hostPath: disallowed, containerPath: '/data' }] } as any,
        timeout: 1000,
        retries: 0
      };

      expect(() => applyGatewaySandboxPolicy(tpl, gw)).toThrow(/Volume hostPath not allowed/i);
    } finally {
      await safeRm(root);
    }
  });

  it('enforces sandbox policy even when calling createStdioAdapter directly', async () => {
    const gwConfig: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { container: { requiredForUntrusted: true } } as any
    };

    const adapters = new ProtocolAdaptersImpl(logger, () => gwConfig);
    const adapter = await adapters.createStdioAdapter({
      name: 't',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'npm',
      args: ['--version'],
      timeout: 1000,
      retries: 0
    } as any);

    expect(adapter).toBeInstanceOf(ContainerTransportAdapter);
  });
});
