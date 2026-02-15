import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutostartManager, type AutostartDeps } from '../../gateway/AutostartManager.js';
import type { Logger } from '../../types/index.js';

const mockLogger: Logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

describe('AutostartManager', () => {
  let deps: AutostartDeps;
  let manager: AutostartManager;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      logger: mockLogger,
      persistence: {
        getAutostartEntries: vi.fn().mockReturnValue([]),
        markStarted: vi.fn(),
      } as any,
      createInstance: vi.fn().mockResolvedValue({ id: 'inst-1' }),
      getTemplate: vi.fn().mockResolvedValue({ name: 'tpl' }),
    };
    manager = new AutostartManager(deps);
  });

  it('returns empty result when no autostart entries', async () => {
    const result = await manager.restoreAll();
    expect(result.started).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('restores a single autostart entry', async () => {
    (deps.persistence.getAutostartEntries as any).mockReturnValue([
      { templateName: 'my-tpl', autostart: true, createdAt: new Date().toISOString() },
    ]);
    (deps.createInstance as any).mockResolvedValue({ id: 'inst-42' });

    const result = await manager.restoreAll();
    expect(result.started).toEqual(['inst-42']);
    expect(deps.createInstance).toHaveBeenCalledWith('my-tpl', undefined);
    expect(deps.persistence.markStarted).toHaveBeenCalledWith('inst-42');
  });

  it('skips entries with missing templates', async () => {
    (deps.persistence.getAutostartEntries as any).mockReturnValue([
      { templateName: 'gone-tpl', autostart: true, createdAt: new Date().toISOString() },
    ]);
    (deps.getTemplate as any).mockResolvedValue(null);

    const result = await manager.restoreAll();
    expect(result.skipped).toEqual(['gone-tpl']);
    expect(result.started).toEqual([]);
    expect(deps.createInstance).not.toHaveBeenCalled();
  });

  it('records failures when createInstance throws', async () => {
    (deps.persistence.getAutostartEntries as any).mockReturnValue([
      { templateName: 'fail-tpl', autostart: true, createdAt: new Date().toISOString() },
    ]);
    (deps.createInstance as any).mockRejectedValue(new Error('spawn failed'));

    const result = await manager.restoreAll();
    expect(result.failed).toEqual([{ templateName: 'fail-tpl', error: 'spawn failed' }]);
    expect(result.started).toEqual([]);
  });

  it('handles mixed results across multiple entries', async () => {
    (deps.persistence.getAutostartEntries as any).mockReturnValue([
      { templateName: 'ok-tpl', autostart: true, createdAt: new Date().toISOString() },
      { templateName: 'gone-tpl', autostart: true, createdAt: new Date().toISOString() },
      { templateName: 'fail-tpl', autostart: true, createdAt: new Date().toISOString() },
    ]);
    (deps.getTemplate as any)
      .mockResolvedValueOnce({ name: 'ok-tpl' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: 'fail-tpl' });
    (deps.createInstance as any)
      .mockResolvedValueOnce({ id: 'inst-ok' })
      .mockRejectedValueOnce(new Error('port in use'));

    const result = await manager.restoreAll();
    expect(result.started).toEqual(['inst-ok']);
    expect(result.skipped).toEqual(['gone-tpl']);
    expect(result.failed).toEqual([{ templateName: 'fail-tpl', error: 'port in use' }]);
  });

  it('passes overrides to createInstance', async () => {
    (deps.persistence.getAutostartEntries as any).mockReturnValue([
      { templateName: 'tpl', overrides: { port: 9999 }, autostart: true, createdAt: new Date().toISOString() },
    ]);

    await manager.restoreAll();
    expect(deps.createInstance).toHaveBeenCalledWith('tpl', { port: 9999 });
  });
});
