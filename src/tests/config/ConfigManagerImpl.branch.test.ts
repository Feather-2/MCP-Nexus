import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { ConfigManagerImpl } from '../../config/ConfigManagerImpl.js';
import type { Logger, GatewayConfig } from '../../types/index.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('ConfigManagerImpl \u2013 branch coverage', () => {
  let tmpDir: string;
  let configFile: string;
  let logger: Logger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-cfgbranch-'));
    configFile = path.join(tmpDir, 'gateway.json');
    logger = makeLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor signatures', () => {
    it('accepts (logger, path) signature', () => {
      const mgr = new ConfigManagerImpl(logger, configFile);
      expect(mgr).toBeDefined();
    });

    it('accepts (logger) only with default path', () => {
      const mgr = new ConfigManagerImpl(logger);
      expect(mgr).toBeDefined();
    });

    it('accepts (path, logger, defaults)', () => {
      const mgr = new ConfigManagerImpl(configFile, logger, { port: 9999 });
      expect(mgr.getConfig().port).toBe(9999);
    });
  });

  describe('loadConfig branches', () => {
    it('creates default config when file does not exist (ENOENT)', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfig();
      expect(cfg).toBeDefined();
      expect(cfg.host).toBeDefined();
    });

    it('creates default when config file is empty', async () => {
      await writeFile(configFile, '', 'utf8');
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfig();
      expect(cfg).toBeDefined();
    });

    it('throws for non-object JSON', async () => {
      await writeFile(configFile, '"just a string"', 'utf8');
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.loadConfig()).rejects.toThrow('Configuration must be an object');
    });

    it('throws for non-ENOENT errors', async () => {
      // Create a directory where the config file should be
      await mkdir(configFile, { recursive: true });
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.loadConfig()).rejects.toThrow('Failed to load configuration');
    });

    it('loads valid config successfully', async () => {
      const cfg = { port: 8080, host: 'localhost' };
      await writeFile(configFile, JSON.stringify(cfg), 'utf8');
      const mgr = new ConfigManagerImpl(configFile, logger);
      const loaded = await mgr.loadConfig();
      expect(loaded.port).toBe(8080);
    });
  });

  describe('saveConfig branches', () => {
    it('throws for invalid port', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveConfig({ port: -1 } as any)).rejects.toThrow('validation failed');
    });

    it('throws for invalid host', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveConfig({ host: '' } as any)).rejects.toThrow('validation failed');
    });

    it('throws for invalid authMode', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveConfig({ authMode: 'bad' } as any)).rejects.toThrow('validation failed');
    });

    it('throws for invalid loadBalancingStrategy', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveConfig({ loadBalancingStrategy: 'bad' } as any)).rejects.toThrow('validation failed');
    });

    it('throws for invalid logLevel', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveConfig({ logLevel: 'bad' } as any)).rejects.toThrow('validation failed');
    });

    it('skips logging when skipLogging=true', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.saveConfig(mgr.getConfig(), true);
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('saved'));
    });
  });

  describe('get/set/delete branches', () => {
    it('get returns null for non-existent nested key', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const val = await mgr.get('a.b.c');
      expect(val).toBeNull();
    });

    it('get returns null when intermediate is undefined', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const val = await mgr.get('rateLimiting.nonexistent.deep');
      expect(val).toBeNull();
    });

    it('set creates nested path', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.set('custom.nested.key', 'value');
      const val = await mgr.get('custom.nested.key');
      expect(val).toBe('value');
    });

    it('set throws for empty key', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.set('', 'val')).rejects.toThrow('Invalid key path');
    });

    it('delete returns false for empty key', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = await mgr.delete('');
      expect(result).toBe(false);
    });

    it('delete returns false for non-existent nested path', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = await mgr.delete('nonexistent.deep.key');
      expect(result).toBe(false);
    });

    it('delete returns true for existing key', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.set('tempKey', 'tempVal');
      const result = await mgr.delete('tempKey');
      expect(result).toBe(true);
    });

    it('delete returns false for non-existent top-level key', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = await mgr.delete('totallyMissing');
      expect(result).toBe(false);
    });
  });

  describe('setAll and clear', () => {
    it('setAll merges config', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.setAll({ logLevel: 'debug' } as any);
      expect(mgr.getConfig().logLevel).toBe('debug');
    });

    it('clear resets to defaults', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger, { port: 9999 });
      await mgr.clear();
      expect(mgr.getConfig().port).toBe(19233); // default port
    });
  });

  describe('template validation', () => {
    it('saveTemplate rejects missing name', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveTemplate({ version: '1', transport: 'stdio', command: 'echo' } as any)).rejects.toThrow('name');
    });

    it('saveTemplate rejects missing version', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveTemplate({ name: 'test', transport: 'stdio', command: 'echo' } as any)).rejects.toThrow('version');
    });

    it('saveTemplate rejects missing transport', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveTemplate({ name: 'test', version: '1' } as any)).rejects.toThrow('transport');
    });

    it('saveTemplate rejects stdio without command', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.saveTemplate({ name: 'test', version: '1', transport: 'stdio' } as any)).rejects.toThrow('Command');
    });
  });

  describe('removeTemplate', () => {
    it('returns false for non-existent template', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = await mgr.removeTemplate('nonexistent');
      expect(result).toBe(false);
    });

    it('removes template and file', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.loadTemplates();
      const result = await mgr.removeTemplate('filesystem');
      expect(result).toBe(true);
    });
  });

  describe('restoreFromBackup branches', () => {
    it('throws when backup file not found', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.restoreFromBackup('/nonexistent/backup.json')).rejects.toThrow('Backup file not found');
    });

    it('restores wrapped config with templates', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mkdir(path.join(tmpDir, 'templates'), { recursive: true });
      const backupPath = path.join(tmpDir, 'backup.json');
      await writeFile(backupPath, JSON.stringify({
        config: { port: 7777, host: 'restored' },
        templates: [{ name: 'tpl', version: '1', transport: 'http' }]
      }), 'utf8');
      await mgr.restoreFromBackup(backupPath);
      expect(mgr.getConfig().port).toBe(7777);
    });

    it('restores raw config JSON', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const backupPath = path.join(tmpDir, 'raw-backup.json');
      await writeFile(backupPath, JSON.stringify({ port: 5555, host: 'raw' }), 'utf8');
      await mgr.restoreFromBackup(backupPath);
      expect(mgr.getConfig().port).toBe(5555);
    });

    it('uses default backup path when none provided', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.restoreFromBackup()).rejects.toThrow('Backup file not found');
    });
  });

  describe('loadConfigWithEnvOverrides', () => {
    it('applies PBMCP_HOST env override', async () => {
      process.env.PBMCP_HOST = 'env-host';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg.host).toBe('env-host');
      delete process.env.PBMCP_HOST;
    });

    it('applies PBMCP_PORT env override', async () => {
      process.env.PBMCP_PORT = '4444';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg.port).toBe(4444);
      delete process.env.PBMCP_PORT;
    });

    it('ignores invalid PBMCP_PORT', async () => {
      process.env.PBMCP_PORT = 'not-a-number';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg.port).not.toBe(NaN);
      delete process.env.PBMCP_PORT;
    });

    it('applies PBMCP_AUTH_MODE env override', async () => {
      process.env.PBMCP_AUTH_MODE = 'dual';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg.authMode).toBe('dual');
      delete process.env.PBMCP_AUTH_MODE;
    });

    it('ignores invalid auth mode', async () => {
      process.env.PBMCP_AUTH_MODE = 'bad-mode';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg.authMode).not.toBe('bad-mode');
      delete process.env.PBMCP_AUTH_MODE;
    });

    it('applies PBMCP_LOG_LEVEL env override', async () => {
      process.env.PBMCP_LOG_LEVEL = 'debug';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg.logLevel).toBe('debug');
      delete process.env.PBMCP_LOG_LEVEL;
    });

    it('returns config unchanged when no env overrides', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const cfg = await mgr.loadConfigWithEnvOverrides();
      expect(cfg).toBeDefined();
    });
  });

  describe('resolveEnvironmentVariables', () => {
    it('resolves env vars in env and args', () => {
      process.env.TEST_KEY_RESOLVE = 'resolved_value';
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = mgr.resolveEnvironmentVariables({
        name: 'test', version: '1', transport: 'stdio', command: 'echo',
        env: { KEY: '${TEST_KEY_RESOLVE}', PLAIN: 'plain' },
        args: ['${TEST_KEY_RESOLVE}', 'literal']
      } as any);
      expect(result.env?.KEY).toBe('resolved_value');
      expect(result.env?.PLAIN).toBe('plain');
      expect(result.args?.[0]).toBe('resolved_value');
      expect(result.args?.[1]).toBe('literal');
      delete process.env.TEST_KEY_RESOLVE;
    });

    it('keeps original value when env var not set', () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = mgr.resolveEnvironmentVariables({
        name: 'test', version: '1', transport: 'stdio', command: 'echo',
        env: { KEY: '${NONEXISTENT_VAR_XYZ}' }
      } as any);
      expect(result.env?.KEY).toBe('${NONEXISTENT_VAR_XYZ}');
    });

    it('handles config without env or args', () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      const result = mgr.resolveEnvironmentVariables({ name: 'test', version: '1', transport: 'http' } as any);
      expect(result).toBeDefined();
    });
  });

  describe('importConfig branches', () => {
    it('imports config with templates', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mkdir(path.join(tmpDir, 'templates'), { recursive: true });
      await mgr.importConfig(JSON.stringify({
        config: { port: 3333 },
        templates: [{ name: 'imported', version: '1', transport: 'http' }]
      }));
      expect(mgr.getConfig().port).toBe(3333);
    });

    it('throws for invalid JSON', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await expect(mgr.importConfig('not json')).rejects.toThrow('Failed to import');
    });
  });

  describe('sanitizeFilename', () => {
    it('strips special characters in template names', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mkdir(path.join(tmpDir, 'templates'), { recursive: true });
      await mgr.saveTemplate({ name: 'test@#$%', version: '1', transport: 'http' } as any);
      const t = mgr.getTemplate('test@#$%');
      expect(t).toBeDefined();
    });
  });

  describe('watchConfig and stopConfigWatch', () => {
    it('startConfigWatch and stopConfigWatch toggle state', async () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.saveConfig(mgr.getConfig());
      mgr.startConfigWatch();
      // calling again should be no-op
      mgr.startConfigWatch();
      mgr.stopConfigWatch();
      // calling again should be no-op
      mgr.stopConfigWatch();
    });

    it('stopWatching calls stopConfigWatch', () => {
      const mgr = new ConfigManagerImpl(configFile, logger);
      mgr.stopWatching();
    });
  });

  describe('loadTemplatesFromDirectory', () => {
    it('loads valid templates from directory', async () => {
      const templatesDir = path.join(tmpDir, 'templates');
      await mkdir(templatesDir, { recursive: true });
      await writeFile(path.join(templatesDir, 'valid.json'), JSON.stringify({
        name: 'valid', version: '1', transport: 'http'
      }), 'utf8');
      await writeFile(path.join(templatesDir, 'invalid.json'), 'not json', 'utf8');
      const mgr = new ConfigManagerImpl(configFile, logger);
      await mgr.loadTemplates();
      expect(mgr.getTemplate('valid')).toBeDefined();
    });
  });
});
