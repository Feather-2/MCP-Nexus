# Config Module

配置管理和外部 MCP 导入。

## Files

| File | Description |
|------|-------------|
| `ConfigManagerImpl.ts` | 配置管理器 |
| `ConfigResolver.ts` | 配置解析 |
| `ExternalMcpConfigImporter.ts` | 外部 MCP 配置导入 |
| `merge.ts` | 配置合并工具 |

## Config Sources

- `config/gateway.yaml` - 主配置
- 环境变量
- CLI 参数

## Key Features

- YAML 配置解析
- 配置验证 (Zod)
- 热重载支持

## External Import

支持从以下格式导入：
- Claude Desktop `claude_desktop_config.json`
- MCP Server 配置

```typescript
const importer = new ExternalMcpConfigImporter(logger);
const templates = await importer.import('/path/to/config.json');
```
