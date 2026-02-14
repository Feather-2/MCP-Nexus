# Dashboard Metrics Specification

**Version**: 1.0.0
**Last Updated**: 2026-02-14

本文档定义 MCP-Nexus 可观测性 Dashboard 的关键指标和布局。

## 核心指标 (KPIs)

### 1. 编排执行指标

| 指标名称 | 类型 | 数据源 | 计算方式 |
|---------|------|--------|---------|
| 执行成功率 | Gauge | `orchestrator:execute:end` | `success=true` 数量 / 总执行数 |
| 平均执行时长 | Histogram | `orchestrator:execute:end` | `durationMs` 的 P50/P95/P99 |
| 步骤失败率 | Gauge | `orchestrator:step:error` | 失败步骤数 / 总步骤数 |
| 并发执行数 | Gauge | `orchestrator:execute:start/end` | 当前进行中的执行数 |

### 2. EventBus 健康指标

| 指标名称 | 类型 | 数据源 | 计算方式 |
|---------|------|--------|---------|
| 背压丢弃率 | Counter | `eventbus:backpressure:drop` | 累计丢弃事件数 |
| 缓冲区丢弃率 | Counter | `eventbus:buffer:drop` | 累计缓冲区丢弃数 |
| 处理器错误率 | Counter | `eventbus:handler:error` | 累计处理器错误数 |
| 处理器超时率 | Counter | `eventbus:handler:timeout` | 累计超时数 |
| 事件吞吐量 | Gauge | EventBus.getStats() | `published` 的速率 (events/sec) |

### 3. LLM 调用指标

| 指标名称 | 类型 | 数据源 | 计算方式 |
|---------|------|--------|---------|
| LLM 调用成功率 | Gauge | AiAuditor.onLlmCall | `success=true` 数量 / 总调用数 |
| LLM 调用延迟 | Histogram | AiAuditor.onLlmCall | `durationMs` 的 P50/P95/P99 |
| Token 使用量 | Counter | AiAuditor.onLlmCall | `maxTokens` 的累计值 |
| 模型分布 | Gauge | AiAuditor.onLlmCall | 按 `model` 分组的调用数 |

### 4. 错误追踪指标

| 指标名称 | 类型 | 数据源 | 计算方式 |
|---------|------|--------|---------|
| 错误发生率 | Counter | ErrorEnvelope | 按 `category` 分组的错误数 |
| 错误严重度分布 | Gauge | ErrorEnvelope | 按 `severity` 分组的错误数 |
| 可恢复错误比例 | Gauge | ErrorEnvelope | `recoverable=true` 数量 / 总错误数 |
| 跨边界错误数 | Counter | ErrorEnvelope | `boundaryStack.length > 1` 的错误数 |

## Dashboard 布局

### Overview Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ MCP-Nexus Observability Overview                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ 执行成功率   │  │ 平均执行时长 │  │ 并发执行数   │    │
│  │   98.5%      │  │   1.2s       │  │     12       │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 执行时长分布 (P50/P95/P99)                          │  │
│  │ [Histogram Chart]                                    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 步骤失败率趋势                                       │  │
│  │ [Time Series Chart]                                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### EventBus Health Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ EventBus Health                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ 事件吞吐量   │  │ 背压丢弃率   │  │ 处理器错误率 │    │
│  │  1.2k/s      │  │    0.01%     │  │    0.05%     │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 治理事件分布                                         │  │
│  │ [Pie Chart: backpressure/buffer/handler/timeout]    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 订阅者缓冲区使用率                                   │  │
│  │ [Heatmap by subscriberId]                            │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### LLM Performance Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ LLM Performance                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ 调用成功率   │  │ 平均延迟     │  │ Token 使用   │    │
│  │   99.2%      │  │   850ms      │  │   125k       │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 延迟分布 (P50/P95/P99)                               │  │
│  │ [Histogram Chart]                                    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 模型使用分布                                         │  │
│  │ [Bar Chart by model]                                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Error Tracking Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ Error Tracking                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ 错误发生率   │  │ 严重错误数   │  │ 可恢复比例   │    │
│  │   0.8%       │  │      3       │  │    75%       │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 错误分类分布                                         │  │
│  │ [Pie Chart by category]                              │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Top 10 错误指纹                                      │  │
│  │ [Table: fingerprint, count, last_seen]               │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ 跨边界错误追踪                                       │  │
│  │ [Sankey Diagram: main → worker → stage → tool]      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 指标采集实现

### 1. Prometheus Exporter

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

const registry = new Registry();

// 编排执行指标
const executeSuccess = new Counter({
  name: 'orchestrator_execute_success_total',
  help: 'Total successful executions',
  registers: [registry],
});

const executeDuration = new Histogram({
  name: 'orchestrator_execute_duration_ms',
  help: 'Execution duration in milliseconds',
  buckets: [100, 500, 1000, 2000, 5000, 10000],
  registers: [registry],
});

// 订阅事件并更新指标
eventBus.subscribe('orchestrator:execute:end', (event) => {
  const { success, durationMs } = event.payload as ExecuteEndPayload;
  if (success) executeSuccess.inc();
  executeDuration.observe(durationMs);
});

// 暴露 /metrics 端点
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
```

### 2. Grafana Dashboard JSON

参考 `docs/observability/grafana-dashboards/` 目录下的预配置 Dashboard JSON。

### 3. 实时指标查询

```typescript
// 查询最近 1 小时的执行成功率
const recentExecutions = await eventLogger.query({
  filter: (e) =>
    e.type === 'orchestrator:execute:end' &&
    e.timestamp > Date.now() - 3600000,
});

const successRate = recentExecutions.filter(
  (e) => (e.payload as ExecuteEndPayload).success
).length / recentExecutions.length;
```

## 告警规则

### 关键告警

| 告警名称 | 条件 | 严重度 | 处理建议 |
|---------|------|--------|---------|
| 执行成功率低 | < 95% (5min) | Critical | 检查 step error 日志，排查失败原因 |
| 背压丢弃率高 | > 1% (1min) | Warning | 增加 queueDepth 或优化订阅者性能 |
| LLM 调用失败率高 | > 5% (5min) | Warning | 检查 LLM 服务可用性和配额 |
| 严重错误发生 | severity=critical | Critical | 立即人工介入，检查错误上下文 |

### Prometheus AlertManager 规则

```yaml
groups:
  - name: mcp-nexus
    rules:
      - alert: OrchestratorExecutionFailureHigh
        expr: |
          (
            rate(orchestrator_execute_success_total[5m]) /
            rate(orchestrator_execute_total[5m])
          ) < 0.95
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Orchestrator execution success rate below 95%"

      - alert: EventBusBackpressureHigh
        expr: rate(eventbus_backpressure_drops_total[1m]) > 0.01
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "EventBus backpressure drop rate above 1%"
```

## 使用指南

### 快速开始

1. **启动 Prometheus**:
   ```bash
   docker run -p 9090:9090 -v ./prometheus.yml:/etc/prometheus/prometheus.yml prom/prometheus
   ```

2. **启动 Grafana**:
   ```bash
   docker run -p 3000:3000 grafana/grafana
   ```

3. **导入 Dashboard**:
   - 访问 http://localhost:3000
   - 导入 `docs/observability/grafana-dashboards/*.json`

### 自定义指标

```typescript
// 添加自定义指标
const customMetric = new Counter({
  name: 'my_custom_metric_total',
  help: 'My custom metric',
  labelNames: ['label1', 'label2'],
  registers: [registry],
});

eventBus.subscribe('my:custom:event', (event) => {
  customMetric.inc({ label1: 'value1', label2: 'value2' });
});
```

## 参考资源

- [Event Dictionary](./EVENT_DICTIONARY.md)
- [OpenTelemetry Integration](./OPENTELEMETRY_INTEGRATION.md)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
