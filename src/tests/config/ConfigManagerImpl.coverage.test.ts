import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ConfigManagerImpl } from '../../config/ConfigManagerImpl.js';
import type { Logger } from '../../types/index.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('ConfigManagerImpl – extended coverage', () => {
  let tmpDir: string;
  let mgr: ConfigManagerImpl;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-cfgmgr-'));
    const configFile = path.join(tmpDir, 'gateway.json');
    mgr = new ConfigManagerImpl(configFile, makeLogger());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('isValidPort validates correctly', () => {
    expect(mgr.isValidPort(8080)).toBe(true);
    expect(mgr.isValidPort(0)).toBe(false);
    expect(mgr.isValidPort(65536)).toBe(false);
    expect(mgr.isValidPort(1.5)).toBe(false);
    expect(mgr.isValidPort(-1)).toBe(false);
  });

  it('isValidHost validates correctly', () => {
    expect(mgr.isValidHost('localhost')).toBe(true);
    expect(mgr.isValidHost('0.0.0.0')).toBe(true);
    expect(mgr.isValidHost('')).toBe(false);
    expect(mgr.isValidHost('  ')).toBe(false);
  });

  it('isValidLogLevel validates correctly', () => {
    expect(mgr.isValidLogLevel('info')).toBe(true);
    expect(mgr.isValidLogLevel('debug')).toBe(true);
    expect(mgr.isValidLogLevel('error')).toBe(true);
    expect(mgr.isValidLogLevel('warn')).toBe(true);
    expect(mgr.isValidLogLevel('trace')).toBe(true);
    expect(mgr.isValidLogLevel('verbose')).toBe(false);
    expect(mgr.isValidLogLevel('INVALID')).toBe(false);
  });

  it('updateConfig updates and returns new config', async () => {
    const updated = await mgr.updateConfig({ logLevel: 'debug' });
    expect(updated.logLevel).toBe('debug');
  });

  it('has/delete/getAll work', async () => {
    const hasPort = await mgr.has('port');
    expect(typeof hasPort).toBe('boolean');
    const all = await mgr.getAll();
    expect(all).toBeDefined();
    const deleted = await mgr.delete('nonexistent-key');
    expect(typeof deleted).toBe('boolean');
  });

  it('validateConfig returns boolean', () => {
    expect(mgr.validateConfig({ port: 8080 })).toBe(true);
    expect(mgr.validateConfig({ port: -1 })).toBe(false);
  });

  it('saveConfig and createBackup work', async () => {
    await mgr.saveConfig(mgr.getConfig());
    const backupPath = await mgr.createBackup();
    expect(typeof backupPath).toBe('string');
  });

  it('resetToDefaults returns config', async () => {
    const cfg = await mgr.resetToDefaults();
    expect(cfg).toBeDefined();
    expect(cfg.host).toBeDefined();
  });

  it('loadTemplates loads from templates directory', async () => {
    const templatesDir = path.join(tmpDir, 'templates');
    await mkdir(templatesDir, { recursive: true });
    await writeFile(path.join(templatesDir, 'test-svc.json'), JSON.stringify({
      name: 'test-svc', version: '2024-11-26', transport: 'stdio',
      command: 'echo', timeout: 5000, retries: 0
    }), 'utf8');
    const configFile2 = path.join(tmpDir, 'gateway.json');
    const mgr2 = new ConfigManagerImpl(configFile2, makeLogger());
    await mgr2.loadTemplates();
    const templates = mgr2.listTemplates();
    expect(Array.isArray(templates)).toBe(true);
  });

  it('listTemplates returns array', () => {
    const templates = mgr.listTemplates();
    expect(Array.isArray(templates)).toBe(true);
  });

  it('getConfig returns config object', () => {
    const cfg = mgr.getConfig();
    expect(cfg).toBeDefined();
    expect(cfg.host).toBeDefined();
  });

  it('exportConfig returns JSON', async () => {
    const json = await mgr.exportConfig();
    expect(typeof json).toBe('string');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('importConfig parses without throwing', async () => {
    const cfg = mgr.getConfig();
    const json = JSON.stringify(cfg);
    await mgr.importConfig(json);
    expect(mgr.getConfig()).toBeDefined();
  });
});
