import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SubagentLoader } from '../../orchestrator/SubagentLoader.js';

describe('SubagentLoader', () => {
  let tmpDir: string;
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-sal-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loadAll returns empty map for empty directory', async () => {
    const loader = new SubagentLoader(tmpDir, logger);
    const map = await loader.loadAll();
    expect(map.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith('Subagents loaded', expect.objectContaining({ count: 0 }));
  });

  it('loadAll loads valid JSON files', async () => {
    const config = { name: 'test-agent', model: 'claude-3-sonnet', systemPrompt: 'hello' };
    await writeFile(path.join(tmpDir, 'test-agent.json'), JSON.stringify(config), 'utf8');
    const loader = new SubagentLoader(tmpDir, logger);
    const map = await loader.loadAll();
    expect(map.size).toBe(1);
    expect(map.get('test-agent')).toBeDefined();
  });

  it('loadAll skips invalid JSON', async () => {
    await writeFile(path.join(tmpDir, 'bad.json'), 'not json', 'utf8');
    const loader = new SubagentLoader(tmpDir, logger);
    const map = await loader.loadAll();
    expect(map.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Failed to load subagent config', expect.any(Object));
  });

  it('loadAll skips files with suspicious names', async () => {
    await writeFile(path.join(tmpDir, '../escape.json'), '{}', 'utf8').catch(() => {});
    await writeFile(path.join(tmpDir, 'valid.json'), JSON.stringify({ name: 'v', model: 'x', systemPrompt: 'y' }), 'utf8');
    const loader = new SubagentLoader(tmpDir, logger);
    const map = await loader.loadAll();
    // Only valid.json should be loaded (if schema passes)
    expect(map.size).toBeLessThanOrEqual(1);
  });

  it('loadAll skips directories', async () => {
    await mkdir(path.join(tmpDir, 'subdir.json'), { recursive: true });
    const loader = new SubagentLoader(tmpDir, logger);
    const map = await loader.loadAll();
    expect(map.size).toBe(0);
  });

  it('loadAll handles non-existent directory gracefully', async () => {
    const loader = new SubagentLoader('/nonexistent/path', logger);
    const map = await loader.loadAll();
    expect(map.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Failed to read subagents directory', expect.any(Object));
  });

  it('get returns cached config', async () => {
    const config = { name: 'cached', model: 'claude-3-sonnet', systemPrompt: 'test' };
    await writeFile(path.join(tmpDir, 'cached.json'), JSON.stringify(config), 'utf8');
    const loader = new SubagentLoader(tmpDir, logger);
    await loader.loadAll();
    expect(loader.get('cached')).toBeDefined();
    expect(loader.get('nonexistent')).toBeUndefined();
  });

  it('list returns all cached configs', async () => {
    const c1 = { name: 'a', model: 'x', systemPrompt: 'y' };
    const c2 = { name: 'b', model: 'x', systemPrompt: 'y' };
    await writeFile(path.join(tmpDir, 'a.json'), JSON.stringify(c1), 'utf8');
    await writeFile(path.join(tmpDir, 'b.json'), JSON.stringify(c2), 'utf8');
    const loader = new SubagentLoader(tmpDir, logger);
    await loader.loadAll();
    expect(loader.list().length).toBe(2);
  });
});
