# OpenTelemetry Backend Integration

本文档提供 Jaeger 和 Tempo 后端的具体集成配置。

## Jaeger 集成

### 1. 使用 Docker 运行 Jaeger

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

访问 UI: http://localhost:16686

### 2. 配置 MCP-Nexus

在 `.env` 文件中添加：

```env
PB_OTEL_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=mcp-nexus
```

### 3. 验证集成

```bash
# 启动 MCP-Nexus
npm run dev

# 执行一些操作触发 traces
curl http://localhost:3000/api/health-status

# 访问 Jaeger UI 查看 traces
open http://localhost:16686
```

## Tempo 集成

### 1. 使用 Docker 运行 Tempo

```bash
docker run -d --name tempo \
  -p 3200:3200 \
  -p 4318:4318 \
  grafana/tempo:latest \
  -config.file=/etc/tempo.yaml
```

### 2. Tempo 配置文件

创建 `tempo.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318

storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/traces

query_frontend:
  search:
    enabled: true
```

### 3. 配置 MCP-Nexus

在 `.env` 文件中添加：

```env
PB_OTEL_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=mcp-nexus
```

### 4. 使用 Grafana 查询 Tempo

```bash
docker run -d --name grafana \
  -p 3001:3000 \
  grafana/grafana:latest
```

在 Grafana 中添加 Tempo 数据源：
- URL: http://tempo:3200
- Type: Tempo

## 完整监控栈 (Jaeger + Prometheus + Grafana)

参考 `docker-compose.observability.yml` 文件启动完整监控栈。

## 环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PB_OTEL_ENABLED` | 启用 OpenTelemetry | `0` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 端点 URL | - |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces 专用端点 | - |
| `OTEL_EXPORTER_OTLP_HEADERS` | 自定义 HTTP 头 | - |
| `OTEL_SERVICE_NAME` | 服务名称 | `mcp-nexus` |
| `OTEL_SDK_DISABLED` | 禁用 SDK | `false` |

## 采样配置

生产环境建议配置采样以降低开销：

```typescript
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const sdk = new NodeSDK({
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.1), // 10% 采样率
  }),
});
```

## 故障排查

### Traces 未出现在后端

1. 检查 OTLP 端点是否可访问：
```bash
curl http://localhost:4318/v1/traces
```

2. 检查 MCP-Nexus 日志：
```bash
npm run dev | grep -i otel
```

3. 验证环境变量：
```bash
echo $PB_OTEL_ENABLED
echo $OTEL_EXPORTER_OTLP_ENDPOINT
```

### 性能开销过大

1. 启用采样（见上文）
2. 减少 span 数量（只追踪关键操作）
3. 使用批量导出（默认已启用）

## 参考资源

- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Tempo Documentation](https://grafana.com/docs/tempo/)
- [OpenTelemetry Integration Guide](./OPENTELEMETRY_INTEGRATION.md)
