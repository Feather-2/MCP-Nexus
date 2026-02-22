import {
  RouteRequest,
  RoutingRule,
  ServiceInstance,
  LoadBalancingStrategy,
  Logger
} from '../types/index.js';

export class RouteEvaluator {
  constructor(private logger: Logger) {}

  applyRoutingRules(
    request: RouteRequest,
    candidateRules: RoutingRule[]
  ): {
    filteredServices: ServiceInstance[];
    preferredServiceIds: Set<string>;
    appliedRules: string[];
  } {
    let filteredServices = [...request.availableServices];
    const appliedRules: string[] = [];
    const preferredServiceIds = new Set<string>();
    let filterApplied = false;

    for (const rule of candidateRules) {
      if (!rule.enabled) continue;
      if (!this.evaluateCondition(rule.condition, request)) continue;

      appliedRules.push(rule.name);
      if (filterApplied && rule.action.type === 'filter') continue;

      switch (rule.action.type) {
        case 'filter':
          if (!rule.action.criteria) break;
          filteredServices = filteredServices.filter(service =>
            this.evaluateServiceFilter(rule.action.criteria!, service)
          );
          this.logger.debug(`Applied filter rule: ${rule.name}`);
          filterApplied = true;
          break;

        case 'prefer':
          if (!rule.action.criteria) break;
          for (const service of filteredServices) {
            if (this.evaluateServiceFilter(rule.action.criteria!, service)) {
              preferredServiceIds.add(service.id);
            }
          }
          break;

        case 'reject':
          if (!rule.action.criteria) break;
          filteredServices = filteredServices.filter(service =>
            !this.evaluateServiceFilter(rule.action.criteria!, service)
          );
          break;

        case 'redirect':
          if (rule.action.targetServiceGroup) {
            this.logger.info(`Redirect rule applied: ${rule.name}`, {
              targetServiceGroup: rule.action.targetServiceGroup
            });
          }
          break;

        case 'allow':
          break;

        case 'deny':
          filteredServices = [];
          break;

        case 'balance':
          break;
      }
    }

    this.logger.debug(`Applied ${appliedRules.length} routing rules`, { appliedRules });
    return { filteredServices, preferredServiceIds, appliedRules };
  }

  evaluateCondition(condition: Record<string, unknown> | string, request: RouteRequest): boolean {
    if (typeof condition === 'string') {
      return request.method === condition ||
             request.serviceGroup === condition || false;
    }

    if (typeof condition === 'object') {
      for (const [key, value] of Object.entries(condition)) {
        switch (key) {
          case 'method':
            if (request.method !== value) return false;
            break;
          case 'serviceGroup':
            if (request.serviceGroup !== value) return false;
            break;
          case 'contentType':
            if (request.contentType !== value) return false;
            break;
          case 'clientIp':
            if (request.clientIp && !request.clientIp.startsWith(value as string)) return false;
            break;
          case 'pathPattern': {
            const path = request.path || '';
            const pattern = String(value);
            if (pattern.endsWith('*')) {
              const prefix = pattern.slice(0, -1);
              if (!path.startsWith(prefix)) return false;
            } else {
              if (path !== pattern) return false;
            }
            break;
          }
          case 'headers': {
            const headers = (request.headers || {}) as Record<string, string>;
            const expected = value as Record<string, string>;
            for (const hk of Object.keys(expected)) {
              if (headers[hk] !== expected[hk]) return false;
            }
            break;
          }
        }
      }
      return true;
    }

    return false;
  }

  evaluateServiceFilter(criteria: Record<string, unknown> | string, service: ServiceInstance): boolean {
    if (typeof criteria === 'string') {
      return service.config.name.includes(criteria) || service.id.includes(criteria);
    }

    if (typeof criteria === 'object') {
      for (const [key, value] of Object.entries(criteria)) {
        switch (key) {
          case 'name':
            if (!service.config.name.includes(value as string)) return false;
            break;
          case 'version':
            if (service.config.version !== value) return false;
            break;
          case 'transport':
            if (service.config.transport !== value) return false;
            break;
        }
      }
      return true;
    }

    return false;
  }

  getRoutingReason(strategy: LoadBalancingStrategy): string {
    switch (strategy) {
      case 'round-robin':
        return 'Selected using round-robin rotation';
      case 'performance-based':
        return 'Selected based on performance metrics and health scores';
      case 'cost-optimized':
        return 'Selected for optimal cost efficiency';
      case 'content-aware':
        return 'Selected based on content type and method compatibility';
      default:
        return 'Selected using default strategy';
    }
  }
}
