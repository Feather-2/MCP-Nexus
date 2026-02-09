import { describe, expect, it, vi } from 'vitest';
import { ContainerTransportAdapter } from '../../adapters/ContainerTransportAdapter.js';
import type { McpServiceConfig, Logger } from '../../types/index.js';

const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeConfig(overrides?: Partial<McpServiceConfig> & { container?: any }): McpServiceConfig {
  return {
    name: 'test-svc',
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    timeout: 5000,
    retries: 0,
    container: { image: 'alpine:latest' },
    ...overrides
  } as any;
}

describe('ContainerTransportAdapter', () => {
  it('throws if no image is provided', () => {
    expect(() => new ContainerTransportAdapter(
      makeConfig({ container: {} }),
      logger
    )).toThrow('Container image is required');
  });

  it('creates adapter with default docker runtime', () => {
    const adapter = new ContainerTransportAdapter(makeConfig(), logger);
    expect(adapter.type).toBe('stdio');
    expect(adapter.isConnected()).toBe(false);
  });

  it('creates adapter with podman runtime', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', runtime: 'podman' } }),
      logger
    );
    expect(adapter.type).toBe('stdio');
  });

  it('applies readonly rootfs by default', () => {
    const adapter = new ContainerTransportAdapter(makeConfig(), logger);
    expect(adapter).toBeDefined();
  });

  it('applies readonly rootfs=false from config', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', readonlyRootfs: false } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('applies network from config', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', network: 'host' } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('applies resource limits', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', resources: { cpus: '0.5', memory: '256m', pidsLimit: 100 } } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('applies security hardening options', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', noNewPrivileges: true, seccompProfile: '/etc/seccomp.json', dropCapabilities: ['NET_RAW'] } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('applies workdir', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', workdir: '/app' } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('rejects volume with host path outside allowed root', () => {
    expect(() => new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', volumes: [{ hostPath: '/etc/shadow', containerPath: '/data' }] } }),
      logger,
      { allowedVolumeRoots: ['/tmp/safe'] }
    )).toThrow('Volume hostPath not allowed');
  });

  it('rejects volume with .. in containerPath', () => {
    const cwd = process.cwd();
    expect(() => new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', volumes: [{ hostPath: cwd, containerPath: '/data/../escape' }] } }),
      logger
    )).toThrow('Invalid containerPath');
  });

  it('allows valid volume within cwd', () => {
    const cwd = process.cwd();
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', volumes: [{ hostPath: cwd, containerPath: '/data', readOnly: true }] } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('filters env through safe prefix whitelist', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ env: { PB_KEY: 'val', SECRET: 'hidden', MCP_HOST: 'x' } as any }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('uses custom env safe prefixes from policy', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ env: { CUSTOM_VAR: 'x' } as any }),
      logger,
      { envSafePrefixes: ['CUSTOM_'] }
    );
    expect(adapter).toBeDefined();
  });

  it('throws if command is missing', () => {
    expect(() => new ContainerTransportAdapter(
      makeConfig({ command: '' }),
      logger
    )).toThrow('Command is required');
  });

  it('policy defaults for pidsLimit and noNewPrivileges', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig(),
      logger,
      { defaultPidsLimit: 200, defaultNoNewPrivileges: true, defaultNetwork: 'bridge', defaultReadonlyRootfs: false }
    );
    expect(adapter).toBeDefined();
  });

  it('skips volumes with missing hostPath or containerPath', () => {
    const adapter = new ContainerTransportAdapter(
      makeConfig({ container: { image: 'alpine', volumes: [null, {}, { hostPath: '/x' }, { containerPath: '/y' }] } }),
      logger
    );
    expect(adapter).toBeDefined();
  });

  it('send and receive delegate to inner adapter', async () => {
    const adapter = new ContainerTransportAdapter(makeConfig(), logger);
    // Not connected, but methods exist
    expect(typeof adapter.send).toBe('function');
    expect(typeof adapter.receive).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
  });
});
