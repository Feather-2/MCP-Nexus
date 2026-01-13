# Gateway Module

服务注册、健康检查、负载均衡和熔断器实现。

## Files

| File | Description |
|------|-------------|
| `ServiceRegistryImpl.ts` | 服务注册表，管理模板和实例 |
| `ServiceHealthChecker.ts` | 健康检查器 |
| `IntelligentLoadBalancer.ts` | 智能负载均衡 (round-robin, 性能优先, 成本优先) |
| `ServiceTemplateManager.ts` | 服务模板管理 |
| `ServiceInstanceManager.ts` | 服务实例生命周期 |
| `CircuitBreaker.ts` | 熔断器模式实现 |
| `BackpressureController.ts` | 背压控制 |
| `TokenBucket.ts` | 令牌桶限流 |

## Key Classes

### ServiceRegistryImpl (extends EventEmitter)

核心注册表，组合多个子系统：
- `templateManager` - 模板 CRUD
- `healthChecker` - 健康状态监控
- `loadBalancer` - 负载均衡策略
- `store` - ServiceObservationStore

主要方法：
- `registerTemplate(config)` - 注册服务模板
- `getTemplate(name)` - 获取模板
- `listTemplates()` - 列出所有模板

### CircuitBreaker

熔断器状态：`closed` → `open` → `half-open` → `closed`

### TokenBucket

令牌桶算法限流，配置 `capacity` 和 `refillRate`。

## Dependencies

- `../types/index.js` - 类型定义
- `./service-state.js` - ServiceObservationStore

## Common Tasks

```typescript
// 注册服务模板
await registry.registerTemplate({
  name: 'my-service',
  transport: 'stdio',
  command: 'node',
  args: ['server.js']
});

// 获取健康服务实例
const instance = await loadBalancer.select('my-service', 'performance');
```
