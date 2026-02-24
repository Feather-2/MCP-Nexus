import { RuleManager } from '../../routing/RuleManager.js';
import type { RoutingRule } from '../../types/index.js';
import {
  createLogger,
  createRouteRequest,
  createService
} from './helpers.js';

describe('routing/RuleManager', () => {
  it('initializes with default rules', () => {
    const manager = new RuleManager(createLogger());
    const names = manager.getRoutingRules().map(rule => rule.name);

    expect(names).toContain('prefer-filesystem-for-file-operations');
    expect(names).toContain('prefer-search-for-query-operations');

    manager.destroy();
  });

  it('adds rules, sorts by priority and emits routingRuleAdded', async () => {
    const manager = new RuleManager(createLogger());
    const onAdded = vi.fn();
    manager.on('routingRuleAdded', onAdded);

    const low: RoutingRule = {
      name: 'low-priority',
      enabled: true,
      priority: 1,
      condition: { method: 'tools/call' },
      action: { type: 'allow' }
    };
    const high: RoutingRule = {
      name: 'high-priority',
      enabled: true,
      priority: 99,
      condition: { method: 'tools/call' },
      action: { type: 'allow' }
    };

    await manager.addRoutingRule(low);
    await manager.addRoutingRule(high);

    const rules = manager.getRoutingRules();
    expect(rules[0]?.name).toBe('high-priority');
    expect(onAdded).toHaveBeenCalledTimes(2);
    expect(onAdded).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'high-priority' }));

    manager.destroy();
  });

  it('rejects duplicate rule names', async () => {
    const manager = new RuleManager(createLogger());
    const rule: RoutingRule = {
      name: 'no-duplicates',
      enabled: true,
      condition: { method: 'tools/call' },
      action: { type: 'allow' }
    };

    await manager.addRoutingRule(rule);
    await expect(manager.addRoutingRule(rule)).rejects.toThrow('already exists');

    manager.destroy();
  });

  it('supports legacy rule format normalization and remove by id', async () => {
    const manager = new RuleManager(createLogger());

    const legacyRule = {
      id: 'legacy-rule-id',
      name: 'legacy-rule-name',
      priority: 20,
      conditions: { method: 'tools/call' },
      actions: { routeTo: ['filesystem'] }
    } as unknown as RoutingRule;

    await manager.addRoutingRule(legacyRule);

    const added = manager.getRoutingRules().find(rule => rule.name === 'legacy-rule-name');
    expect(added).toBeDefined();
    expect(added?.action).toEqual({
      type: 'filter',
      criteria: { name: 'filesystem' }
    });
    expect(added?.enabled).toBe(true);

    await expect(manager.removeRoutingRule('legacy-rule-id')).resolves.toBe(true);

    manager.destroy();
  });

  it('removeRoutingRule returns false when rule does not exist and emits on success', async () => {
    const manager = new RuleManager(createLogger());
    const onRemoved = vi.fn();
    manager.on('routingRuleRemoved', onRemoved);

    const rule: RoutingRule = {
      name: 'to-remove',
      enabled: true,
      condition: { method: 'tools/call' },
      action: { type: 'allow' }
    };

    await manager.addRoutingRule(rule);
    await expect(manager.removeRoutingRule('to-remove')).resolves.toBe(true);
    await expect(manager.removeRoutingRule('missing-rule')).resolves.toBe(false);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ name: 'to-remove' }));

    manager.destroy();
  });

  it('disable/enable updates candidate path rules and keeps priority order', async () => {
    const manager = new RuleManager(createLogger());
    const services = [createService('svc-1')];
    const request = createRouteRequest(services, {
      method: 'tools/call',
      path: '/admin/users'
    });

    const pathRule: RoutingRule = {
      name: 'admin-path',
      enabled: true,
      priority: 60,
      condition: { pathPattern: '/admin/*' },
      action: { type: 'allow' }
    };
    const nonPathRule: RoutingRule = {
      name: 'generic-method',
      enabled: true,
      priority: 30,
      condition: { method: 'tools/call' },
      action: { type: 'allow' }
    };

    await manager.addRoutingRule(pathRule);
    await manager.addRoutingRule(nonPathRule);

    const enabledCandidates = manager.getCandidateRules(request).map(rule => rule.name);
    expect(enabledCandidates[0]).toBe('admin-path');
    expect(enabledCandidates).toContain('generic-method');

    manager.disableRoutingRule('admin-path');
    const disabledCandidates = manager.getCandidateRules(request).map(rule => rule.name);
    expect(disabledCandidates).not.toContain('admin-path');
    expect(disabledCandidates).toContain('generic-method');

    manager.enableRoutingRule('admin-path');
    const reEnabledCandidates = manager.getCandidateRules(request).map(rule => rule.name);
    expect(reEnabledCandidates[0]).toBe('admin-path');

    manager.destroy();
  });

  it('throws for invalid rules missing required fields', async () => {
    const manager = new RuleManager(createLogger());

    await expect(
      manager.addRoutingRule({ name: 'invalid', enabled: true } as unknown as RoutingRule)
    ).rejects.toThrow('missing required fields');

    manager.destroy();
  });
});

