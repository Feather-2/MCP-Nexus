import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrchestratorManager } from '../../orchestrator/OrchestratorManager.js';
import type { Logger, OrchestratorConfig } from '../../types/index.js';
import path from 'path';

const { readFileMock, writeFileMock, mkdirMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  mkdirMock: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('fs', () => ({
  promises: {
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock
  }
}));

describe('OrchestratorManager', () => {
  const baseConfigPath = path.join('/tmp', 'config', 'gateway.json');
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    readFileMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();
  });

  it('loads orchestrator configuration when file exists', async () => {
    const fileConfig: OrchestratorConfig = {
      enabled: true,
      mode: 'auto',
      planner: {
        provider: 'local',
        model: 'planner-test',
        maxSteps: 4,
        fallbackRemote: true
      },
      vectorStore: { provider: 'pgvector', conn: 'postgres://example' },
      reranker: { provider: 'bge-reranker', model: 'rerank-test' },
      budget: { maxTokens: 1000, concurrency: { global: 4, perSubagent: 1 } },
      routing: { preferLocal: false },
      subagentsDir: '../subagents'
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(fileConfig));

    const manager = new OrchestratorManager(baseConfigPath, mockLogger);
    const loaded = await manager.loadConfig();

    expect(loaded.enabled).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith('Orchestrator configuration loaded', expect.objectContaining({
      enabled: true,
      mode: 'auto',
      subagentsDir: expect.any(String)
    }));

    const status = manager.getStatus();
    expect(status.enabled).toBe(true);
    expect(path.resolve(status.subagentsDir)).toBe(path.resolve(path.join('/tmp', 'subagents')));
  });

  it('falls back to defaults when configuration file missing', async () => {
    readFileMock.mockRejectedValueOnce({ code: 'ENOENT' });

    const manager = new OrchestratorManager(baseConfigPath, mockLogger);
    const loaded = await manager.loadConfig();

    expect(loaded.enabled).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith('Orchestrator configuration not found, fallback to defaults', expect.any(Object));
    expect(writeFileMock).toHaveBeenCalled();

    const status = manager.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain('disabled');
  });

  it('gracefully handles invalid JSON', async () => {
    readFileMock.mockResolvedValueOnce('not-json');

    const manager = new OrchestratorManager(baseConfigPath, mockLogger);
    const loaded = await manager.loadConfig();

    expect(loaded.enabled).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith('Failed to parse orchestrator configuration, using defaults', expect.any(Object));
  });

  it('updates orchestrator config and persists to disk', async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ enabled: false, mode: 'manager-only', subagentsDir: './config/subagents' }));
    const manager = new OrchestratorManager(baseConfigPath, mockLogger);
    await manager.loadConfig();

    const updated = await manager.updateConfig({ enabled: true, mode: 'auto', routing: { preferLocal: false } });

    expect(updated.enabled).toBe(true);
    expect(updated.mode).toBe('auto');
    expect(updated.routing?.preferLocal).toBe(false);
    expect(writeFileMock).toHaveBeenCalled();
  });
});
