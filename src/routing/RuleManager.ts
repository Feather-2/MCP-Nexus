import {
  RoutingRule,
  RouteRequest,
  Logger
} from '../types/index.js';
import { RadixTree } from './RadixTree.js';
import { EventEmitter } from 'events';

export class RuleManager extends EventEmitter {
  private routingRules: RoutingRule[] = [];
  private pathRuleIndex = new RadixTree<RoutingRule>();
  private nonPathRules: RoutingRule[] = [];

  constructor(private logger: Logger) {
    super();
    this.initializeDefaultRules();
    this.rebuildRuleIndex();
  }

  async addRoutingRule(rule: RoutingRule): Promise<void> {
    const normalized = this.normalizeRule(rule as unknown as Record<string, unknown>);
    if (!normalized.name || !normalized.condition || !normalized.action) {
      throw new Error('Invalid routing rule: missing required fields');
    }

    if (this.routingRules.some(r => r.name === normalized.name)) {
      throw new Error(`Routing rule with name '${normalized.name}' already exists`);
    }

    this.routingRules.push(normalized);
    this.routingRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.rebuildRuleIndex();

    this.logger.info(`Added routing rule: ${normalized.name}`, { rule: normalized });
    this.emit('routingRuleAdded', normalized);
  }

  async removeRoutingRule(ruleName: string): Promise<boolean> {
    const index = this.routingRules.findIndex(r => r.name === ruleName || (r as unknown as Record<string, unknown>).id === ruleName);

    if (index === -1) {
      return false;
    }

    const removedRule = this.routingRules.splice(index, 1)[0];
    this.rebuildRuleIndex();
    this.logger.info(`Removed routing rule: ${ruleName}`);
    this.emit('routingRuleRemoved', removedRule);

    return true;
  }

  getRoutingRules(): RoutingRule[] {
    return [...this.routingRules];
  }

  disableRoutingRule(ruleName: string): void {
    const rule = this.routingRules.find(r => r.name === ruleName || (r as unknown as Record<string, unknown>).id === ruleName);
    if (rule) {
      rule.enabled = false;
      this.rebuildRuleIndex();
    }
  }

  enableRoutingRule(ruleName: string): void {
    const rule = this.routingRules.find(r => r.name === ruleName || (r as unknown as Record<string, unknown>).id === ruleName);
    if (rule) {
      rule.enabled = true;
      this.rebuildRuleIndex();
    }
  }

  getCandidateRules(request: RouteRequest): RoutingRule[] {
    const path = String(request.path ?? '');
    const candidates = [...this.nonPathRules, ...this.pathRuleIndex.match(path)];

    const seen = new Set<RoutingRule>();
    const unique: RoutingRule[] = [];
    for (const rule of candidates) {
      if (seen.has(rule)) continue;
      seen.add(rule);
      unique.push(rule);
    }

    unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return unique;
  }

  private rebuildRuleIndex(): void {
    const tree = new RadixTree<RoutingRule>();
    const nonPathRules: RoutingRule[] = [];

    for (const rule of this.routingRules) {
      if (!rule.enabled) continue;
      const pattern = this.getRulePathPattern(rule);
      if (pattern) tree.insert(pattern, rule);
      else nonPathRules.push(rule);
    }

    this.pathRuleIndex = tree;
    this.nonPathRules = nonPathRules;
  }

  private getRulePathPattern(rule: RoutingRule): string | null {
    const condition = rule?.condition as unknown;
    if (!condition || typeof condition !== 'object') return null;
    if (!('pathPattern' in condition)) return null;
    const value = (condition as Record<string, unknown>).pathPattern;
    if (value == null) return null;
    return String(value);
  }

  private normalizeRule(input: Record<string, unknown>): RoutingRule {
    if (input && input.id && input.conditions && input.actions) {
      const criteriaNames = input.actions as Record<string, unknown> | undefined;
      const routeTo = (criteriaNames as Record<string, unknown>)?.routeTo as string[] | undefined;
      const name = (input.name || input.id) as string;
      const condition = this.convertConditions(input.conditions as Record<string, unknown>);
      const action = routeTo && routeTo.length
        ? { type: 'filter', criteria: { name: routeTo[0] } }
        : { type: 'allow' };
      return {
        ...(input.id ? { id: input.id } : {}),
        name,
        enabled: input.enabled !== false,
        priority: (input.priority as number) ?? 0,
        condition,
        action
      } as RoutingRule;
    }
    return input as unknown as RoutingRule;
  }

  private convertConditions(conds: unknown): unknown {
    return conds || {};
  }

  private initializeDefaultRules(): void {
    this.routingRules = [
      {
        name: 'prefer-filesystem-for-file-operations',
        enabled: true,
        priority: 10,
        condition: { method: 'files/' },
        action: {
          type: 'prefer',
          criteria: { name: 'filesystem' }
        }
      },
      {
        name: 'prefer-search-for-query-operations',
        enabled: true,
        priority: 10,
        condition: { method: 'search' },
        action: {
          type: 'prefer',
          criteria: { name: 'search' }
        }
      }
    ];
  }
}
