import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigResolver } from '../../config/ConfigResolver.js';

describe('ConfigResolver', () => {
  it('loads schema defaults', () => {
    const defaults = ConfigResolver.loadDefault();
    expect(defaults).toMatchObject({
      host: '127.0.0.1',
      port: 19233,
      rateLimiting: { store: 'memory' }
    });
  });

  it('returns null for missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pbmcp-config-'));
    try {
      const missing = join(dir, 'gateway.local.json');
      const loaded = await ConfigResolver.loadFromFile(missing);
      expect(loaded).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pbmcp-config-'));
    try {
      const file = join(dir, 'gateway.json');
      await writeFile(file, '{ invalid json }', 'utf-8');
      await expect(ConfigResolver.loadFromFile(file)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when JSON is not an object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pbmcp-config-'));
    try {
      const file = join(dir, 'gateway.json');
      await writeFile(file, JSON.stringify([{ port: 123 }]), 'utf-8');
      await expect(ConfigResolver.loadFromFile(file)).rejects.toThrow('expected an object');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads env overrides (and ignores invalid values)', () => {
    const original = process.env;
    process.env = {
      ...original,
      PB_GATEWAY_HOST: '0.0.0.0',
      PB_GATEWAY_PORT: '8080',
      PB_GATEWAY_AUTH_MODE: 'external-secure',
      PB_GATEWAY_LOG_LEVEL: 'debug'
    };

    try {
      const env = ConfigResolver.loadFromEnv();
      expect(env).toEqual({
        host: '0.0.0.0',
        port: 8080,
        authMode: 'external-secure',
        logLevel: 'debug'
      });

      process.env = { ...original, PB_GATEWAY_PORT: 'not-a-number' };
      expect(ConfigResolver.loadFromEnv()).toEqual({});
    } finally {
      process.env = original;
    }
  });

  it('resolves layers with correct precedence', () => {
    const resolver = new ConfigResolver();
    resolver.addLayer({ name: 'Default', priority: 10, config: ConfigResolver.loadDefault() });
    resolver.addLayer({
      name: 'Project',
      priority: 20,
      config: { corsOrigins: ['http://a.local'], rateLimiting: { enabled: true } }
    });
    resolver.addLayer({
      name: 'Local',
      priority: 30,
      config: { corsOrigins: ['http://b.local', 'http://c.local'], rateLimiting: { maxRequests: 5 } }
    });
    resolver.addLayer({ name: 'Runtime', priority: 40, config: { port: 8080 } });
    resolver.addLayer({ name: 'Managed', priority: 50, config: { port: 9999 } });

    const resolved = resolver.resolve();

    expect(resolved.port).toBe(9999);
    expect(resolved.corsOrigins).toEqual(['http://b.local', 'http://c.local']);
    expect(resolved.rateLimiting).toMatchObject({
      enabled: true,
      maxRequests: 5,
      store: 'memory'
    });
  });

  it('validates resolved config via schema', () => {
    const resolver = new ConfigResolver();
    resolver.addLayer({ name: 'Runtime', priority: 10, config: { port: 'nope' } as unknown as { port: number } });
    expect(() => resolver.resolve()).toThrow();
  });
});

