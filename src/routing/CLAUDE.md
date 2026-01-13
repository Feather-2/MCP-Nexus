# Routing Module

智能路由系统，支持多种负载均衡策略和复杂度分析。

## Files

| File | Description |
|------|-------------|
| `index.ts` | 模块导出入口（对外 re-export） |
| `GatewayRouterImpl.ts` | 路由器主实现 |
| `RadixTree.ts` | Radix Tree 数据结构，用于路径匹配 |
| `complexity.ts` | 请求复杂度分析 |
| `delegate.ts` | 路由委托逻辑 |
| `tier-router.ts` | 分层路由 |
| `memory/` | 路由相关内存存储 |

## Key Classes

### GatewayRouterImpl (extends EventEmitter)

核心路由器，维护：
- `routingRules` - 路由规则列表
- `routeHandlers` - 路由处理器 Map
- `pathRuleIndex` - RadixTree 路径索引
- `serviceMetrics` - 服务负载指标
- `costMetrics` - 服务成本指标
- `contentAnalysis` - 内容分析结果

负载均衡策略 (`LoadBalancingStrategy`):
- `round-robin` - 轮询
- `performance-based` - 基于响应时间和成功率
- `cost-optimized` - 基于成本指标选择更低成本服务
- `content-aware` - 根据请求内容选择

### RadixTree

高效路径匹配数据结构，支持：
- 精确匹配
- 通配符前缀匹配（如 `/api/*`、`*`）
- 最长前缀匹配（`findLongestPrefix`）

## Common Tasks

```typescript
// 添加路由规则
router.addRoute('/api/tools/:toolId', handler);

// 路由请求
const response = await router.route({
  path: '/api/tools/my-tool',
  method: 'POST',
  body: { ... }
});

// 获取服务指标
const metrics = router.getServiceMetrics('service-id');
```
