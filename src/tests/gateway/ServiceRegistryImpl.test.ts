import { ServiceRegistryImpl } from '../../gateway/ServiceRegistryImpl.js';
import { ServiceTemplateManager } from '../../gateway/ServiceTemplateManager.js';
import { ServiceHealthChecker } from '../../gateway/ServiceHealthChecker.js';
import { IntelligentLoadBalancer } from '../../gateway/IntelligentLoadBalancer.js';
import type { Logger, McpServiceConfig, ServiceInstance } from '../../types/index.js';

vi.mock('../../gateway/ServiceTemplateManager.js');
vi.mock('../../gateway/ServiceHealthChecker.js');
vi.mock('../../gateway/IntelligentLoadBalancer.js');

function makeTemplate(name: string, overrides: Partial<McpServiceConfig> = {}): McpServiceConfig {
  return {
    name,
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['-v'],
    timeout: 5000,
    retries: 2,
    ...overrides
  };
}

describe('ServiceRegistryImpl (store façade)', () => {
  let registry: ServiceRegistryImpl;
  let mockLogger: Logger;
  let mockTemplateManager: ServiceTemplateManager;
  let mockHealthChecker: ServiceHealthChecker;
  let mockLoadBalancer: IntelligentLoadBalancer;

  beforeEach(() => {
    mockLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    mockTemplateManager = {
      register: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      list: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      initializeDefaults: vi.fn()
    } as any;

    mockHealthChecker = {
      setProbe: vi.fn(),
      startMonitoring: vi.fn().mockResolvedValue(undefined),
      stopMonitoring: vi.fn().mockResolvedValue(undefined),
      checkHealth: vi.fn(),
      getHealthStatus: vi.fn().mockResolvedValue({}),
      getHealthStats: vi.fn().mockResolvedValue({ monitoring: 0, healthy: 0, unhealthy: 0, avgLatency: 0 }),
      getPerServiceStats: vi.fn().mockReturnValue([])
    } as any;

    mockLoadBalancer = {
      addInstance: vi.fn(),
      removeInstance: vi.fn(),
      selectInstance: vi.fn()
    } as any;

    vi.mocked(ServiceTemplateManager).mockImplementation(() => mockTemplateManager);
    vi.mocked(ServiceHealthChecker).mockImplementation(() => mockHealthChecker);
    vi.mocked(IntelligentLoadBalancer).mockImplementation(() => mockLoadBalancer);

    registry = new ServiceRegistryImpl(mockLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registerTemplate updates the observation store', async () => {
    const template = makeTemplate('svc-a');
    vi.mocked(mockTemplateManager.get).mockResolvedValueOnce(template);

    await registry.registerTemplate(template);

    expect(mockTemplateManager.register).toHaveBeenCalledWith(template);
    expect(mockTemplateManager.get).toHaveBeenCalledWith('svc-a');

    const store = (registry as any).store;
    expect(store.getTemplate('svc-a')).toEqual(template);
  });

  it('createInstance persists instance+metrics in store (atomically)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const template = makeTemplate('svc-a');
    vi.mocked(mockTemplateManager.get).mockResolvedValue(template);

    const instance = await registry.createInstance('svc-a', { timeout: 10000 });
    expect(instance.id).toMatch(/^svc-a-/);
    expect(instance.config.timeout).toBe(10000);

    const store = (registry as any).store;
    expect(store.getInstance(instance.id)).toEqual(instance);
    expect(store.getMetrics(instance.id)).toMatchObject({ serviceId: instance.id, requestCount: 0, errorCount: 0 });
  });

  it('createInstance respects instanceMode=managed (no monitoring)', async () => {
    const template = makeTemplate('svc-a');
    vi.mocked(mockTemplateManager.get).mockResolvedValue(template);

    const instance = await registry.createInstance('svc-a', { instanceMode: 'managed' } as any);
    expect(instance.metadata.mode).toBe('managed');
    expect(mockHealthChecker.startMonitoring).not.toHaveBeenCalled();
  });

  it('removeInstance removes instance and derived state from store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const template = makeTemplate('svc-a');
    vi.mocked(mockTemplateManager.get).mockResolvedValue(template);

    const instance = await registry.createInstance('svc-a');
    const store = (registry as any).store;

    // Seed derived state to verify cascading removal.
    store.updateHealth(instance.id, { healthy: true, timestamp: new Date() });
    store.updateMetrics(instance.id, {
      serviceId: instance.id,
      requestCount: 3,
      errorCount: 1,
      avgResponseTime: 10,
      addedAt: new Date(),
      lastRequestTime: new Date()
    });

    await registry.removeInstance(instance.id);

    expect(mockHealthChecker.stopMonitoring).toHaveBeenCalledWith(instance.id);
    expect(store.getInstance(instance.id)).toBeUndefined();
    expect(store.getHealth(instance.id)).toBeUndefined();
    expect(store.getMetrics(instance.id)).toBeUndefined();
  });

  it('selectBestInstance filters by template and does not trigger probes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const templateA = makeTemplate('svc-a');
    const templateB = makeTemplate('svc-b');
    vi.mocked(mockTemplateManager.get).mockImplementation(async (name: string) => (name === 'svc-b' ? templateB : templateA));

    const i1 = await registry.createInstance('svc-a');
    vi.advanceTimersByTime(1);
    const i2 = await registry.createInstance('svc-a');
    vi.advanceTimersByTime(1);
    await registry.createInstance('svc-b');

    vi.mocked(mockLoadBalancer.selectInstance).mockImplementation((instances: ServiceInstance[]) => instances[0] ?? null);
    (mockHealthChecker.checkHealth as any).mockImplementation(() => {
      throw new Error('probe should not run');
    });

    const selected = await registry.selectBestInstance('svc-a');

    expect(selected?.id).toBe(i1.id);
    expect(mockLoadBalancer.selectInstance).toHaveBeenCalledWith([i1, i2], 'performance');
    expect(mockHealthChecker.checkHealth).not.toHaveBeenCalled();
  });

  it('getRegistryStats does not trigger probes (reads health from store)', async () => {
    const template = makeTemplate('svc-a');
    vi.mocked(mockTemplateManager.list).mockResolvedValueOnce([template]);
    vi.mocked(mockTemplateManager.get).mockResolvedValue(template);
    (mockHealthChecker.checkHealth as any).mockImplementation(() => {
      throw new Error('probe should not run');
    });

    const instance = await registry.createInstance('svc-a');
    const store = (registry as any).store;
    store.updateHealth(instance.id, { healthy: true, timestamp: new Date() });

    const stats = await registry.getRegistryStats();
    expect(stats.totalTemplates).toBe(1);
    expect(stats.totalInstances).toBe(1);
    expect(stats.healthyInstances).toBe(1);
    expect(mockHealthChecker.checkHealth).not.toHaveBeenCalled();
  });

  it('selectInstance does not trigger probes (falls back when no cached health)', async () => {
    const template = makeTemplate('svc-a');
    vi.mocked(mockTemplateManager.get).mockResolvedValue(template);
    (mockHealthChecker.checkHealth as any).mockImplementation(() => {
      throw new Error('probe should not run');
    });
    vi.mocked(mockLoadBalancer.selectInstance).mockImplementation((instances: ServiceInstance[]) => instances[0] ?? null);

    const instance = await registry.createInstance('svc-a');
    const selected = await registry.selectInstance('svc-a');

    expect(selected?.id).toBe(instance.id);
    expect(mockHealthChecker.checkHealth).not.toHaveBeenCalled();
  });
});
