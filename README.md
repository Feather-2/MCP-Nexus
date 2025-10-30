# PB MCP Gateway

🚀 **一个功能完整的 TypeScript MCP 协议网关平台**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

PB MCP Gateway 是一个生产就绪的 Model Context Protocol (MCP) 网关实现，提供了完整的服务管理、智能路由、负载均衡、认证授权，以及强大的 Orchestrator 编排层和 MCP 服务生成器。

## ✨ 核心特性

### 🔄 多传输协议支持
- **Stdio** - 标准输入输出通信，适用于本地进程
- **HTTP** - HTTP 请求响应模式，适用于 RESTful API
- **Streamable HTTP** - 基于 Server-Sent Events 的流式通信，支持实时数据流

### 🛡️ 认证与授权
- **多种认证模式** - `local-trusted`（本地信任）、`external-secure`（外部认证）、`dual`（混合模式）
- **Token 管理** - JWT Token 生成、验证、撤销
- **API Key 管理** - API Key 的创建、权限控制和生命周期管理

### 🧠 智能路由与负载均衡
- **性能优化路由** - 基于响应时间和成功率的智能路由
- **成本优化路由** - 优先使用本地服务，降低 API 调用成本
- **内容感知路由** - 根据请求内容智能选择最佳服务
- **多种负载均衡策略** - Round-robin、性能优先、成本优先

### 🎯 Orchestrator 智能编排层
- **自动任务规划** - 智能分解复杂任务，自动选择最佳工具组合
- **多服务协作** - 协调多个 MCP 服务完成单一服务无法完成的工作
- **成本控制** - 预算管理、并发控制、超时保护
- **子代理管理** - 灵活的子代理配置和监控
- **向量检索** - 支持向量数据库和重排序模型

### ✨ MCP 服务生成器
- **多格式解析** - 支持 Markdown、OpenAPI、纯文本等格式
- **自动适配器生成** - 自动生成 MCP 服务配置和适配器代码
- **模板管理** - 模板的创建、导入、导出和分享
- **一键部署** - 生成后直接注册到模板库

### 📊 监控与管理
- **健康检查** - 实时服务健康状态监控
- **性能指标** - 请求计数、响应时间、成功率统计
- **实时日志** - 通过 WebSocket 实时查看服务日志
- **Web GUI** - 现代化的 Web 管理界面

### 🌐 Web GUI 界面
- **现代化设计** - 基于 Radix UI 和 Tailwind CSS
- **响应式布局** - 支持桌面和移动设备
- **深色模式** - 自动主题切换
- **11 个功能页面** - 仪表板、服务管理、模板管理、认证管理、监控、编排器、生成器等

## 🚀 快速开始

### 前置要求

- Node.js >= 18.0.0
- npm 或 yarn

### 安装

```bash
# 克隆仓库
git clone <your-repo>
cd pb-mcpgateway

# 安装依赖
npm install

# 构建项目
npm run build
```

### 启动方式

#### 方式 1: Web GUI（推荐）

```bash
npm run gui
```

在浏览器中访问：http://localhost:19233

#### 方式 2: 快速开始示例

```bash
npm run quick-start
```

#### 方式 3: CLI 命令行

```bash
npm run cli
```

CLI 命令：
```bash
pb-mcp> start    # 启动网关
pb-mcp> status   # 查看状态
pb-mcp> help     # 显示帮助
pb-mcp> stop     # 停止网关
pb-mcp> exit     # 退出
```

#### 方式 4: 编程方式

```typescript
import { createGateway } from './dist/PbMcpGateway.js';

async function example() {
  // 创建网关实例
  const gateway = createGateway({
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    logLevel: 'info'
  });

  // 启动网关
  await gateway.start();

  // 创建服务
  const serviceId = await gateway.createService('memory', {
    env: {}
  });

  // 查看服务状态
  const services = await gateway.listServices();
  console.log('运行中的服务:', services.length);

  // 停止网关
  await gateway.stop();
}
```

## 📋 项目结构

```
pb-mcpgateway/
├── src/                      # 源代码目录
│   ├── adapters/            # 传输适配器（stdio/http/streamable-http）
│   ├── auth/                # 认证授权系统
│   ├── config/              # 配置管理
│   ├── core/                # 核心协议处理
│   ├── gateway/             # 服务注册和健康检查
│   ├── generator/           # MCP 服务生成器
│   ├── orchestrator/        # 智能编排层
│   ├── router/              # 路由和负载均衡
│   ├── server/              # HTTP API 服务器
│   ├── types/               # TypeScript 类型定义
│   ├── utils/               # 工具函数
│   └── tests/               # 测试文件
├── gui/                     # Web GUI 前端
│   └── src/
│       ├── pages/           # 页面组件
│       ├── components/      # UI 组件
│       └── api/             # API 客户端
├── config/                  # 配置文件
│   ├── gateway.json         # 网关配置
│   ├── orchestrator.json    # 编排器配置
│   └── templates/           # 服务模板
├── templates/               # 模板示例
└── dist/                    # 编译输出
```

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP API Server                      │
│                    (Fastify + WebSocket)                │
└─────────────────────┬───────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
    ┌─────▼─────┐ ┌──▼──┐ ┌─────▼─────┐
    │  Web GUI  │ │ CLI │ │  REST API │
    └───────────┘ └─────┘ └───────────┘
                      │
          ┌───────────┴───────────┐
          │   PbMcpGateway Core   │
          └───────────┬───────────┘
                      │
    ┌─────────────────┼─────────────────┐
    │                 │                 │
┌───▼────┐    ┌───────▼──────┐   ┌─────▼──────┐
│ Auth   │    │ Orchestrator │   │ Generator  │
│ Layer  │    │   Engine     │   │            │
└───┬────┘    └───────┬──────┘   └─────┬──────┘
    │                 │                 │
┌───▼─────────────────▼─────────────────▼─────┐
│        Service Registry & Router            │
│  (负载均衡、健康检查、服务发现)              │
└───────────────┬─────────────────────────────┘
                │
    ┌───────────┼───────────┐
    │           │           │
┌───▼───┐  ┌───▼───┐  ┌───▼───┐
│Stdio  │  │ HTTP  │  │Stream │
│Adapter│  │Adapter│  │Adapter│
└───────┘  └───────┘  └───────┘
```

## 🔧 配置说明

### 网关配置 (`config/gateway.json`)

```json
{
  "host": "127.0.0.1",
  "port": 19233,
  "authMode": "local-trusted",
  "routingStrategy": "performance",
  "loadBalancingStrategy": "performance-based",
  "maxConcurrentServices": 50,
  "logLevel": "info",
  "enableHealthChecks": true,
  "healthCheckInterval": 30000,
  "requestTimeout": 30000,
  "maxRetries": 3,
  "enableMetrics": true
}
```

### 编排器配置 (`config/orchestrator.json`)

```json
{
  "enabled": true,
  "mode": "auto",
  "planner": {
    "provider": "local",
    "model": "local-planner",
    "maxSteps": 8,
    "fallbackRemote": true
  },
  "budget": {
    "maxTokens": 200000,
    "maxTimeMs": 300000,
    "maxCostUsd": 1.5,
    "concurrency": {
      "global": 8,
      "perSubagent": 2
    }
  },
  "subagentsDir": "./config/subagents"
}
```

### 认证模式

- **local-trusted** - 本地网络自动信任，无需认证（开发环境推荐）
- **external-secure** - 需要 Token 或 API Key 认证（生产环境推荐）
- **dual** - 本地信任 + 外部认证（混合模式）

## 🌐 HTTP API 接口

### 服务管理

```bash
# 列出所有服务
GET /api/services

# 创建服务实例
POST /api/services
Content-Type: application/json
{
  "templateName": "memory",
  "instanceArgs": {
    "env": {}
  }
}

# 获取服务详情
GET /api/services/:id

# 停止服务
DELETE /api/services/:id

# 检查服务健康状态
GET /api/services/:id/health
```

### 模板管理

```bash
# 列出可用模板
GET /api/templates

# 注册新模板
POST /api/templates
Content-Type: application/json
{
  "name": "my-service",
  "transport": "stdio",
  "command": "node",
  "args": ["service.js"]
}

# 删除模板
DELETE /api/templates/:name
```

### 认证管理

```bash
# 生成访问 Token
POST /api/auth/token
Content-Type: application/json
{
  "userId": "user123",
  "permissions": ["read", "write"],
  "expiresInHours": 24
}

# 创建 API Key
POST /api/auth/apikey
Content-Type: application/json
{
  "name": "my-key",
  "permissions": ["read"]
}

# 撤销 Token
DELETE /api/auth/token/:token

# 撤销 API Key
DELETE /api/auth/apikey/:key
```

### 编排器接口

```bash
# 获取编排器状态
GET /api/orchestrator/status

# 执行编排任务
POST /api/orchestrator/execute
Content-Type: application/json
{
  "goal": "完成一个复杂的任务",
  "maxSteps": 8,
  "timeoutMs": 300000
}

# 列出子代理
GET /api/orchestrator/subagents
```

### 生成器接口

```bash
# 生成 MCP 服务
POST /api/generator/generate
Content-Type: application/json
{
  "source": {
    "type": "markdown",
    "content": "## API Documentation\n..."
  },
  "options": {
    "name": "my-service",
    "transport": "auto",
    "autoRegister": true
  }
}

# 导出模板
POST /api/generator/export
Content-Type: application/json
{
  "templateName": "my-service",
  "format": "json"
}
```

### 监控接口

```bash
# 健康检查
GET /health

# 详细健康状态
GET /api/health-status

# 系统指标
GET /api/metrics
```

## 📦 内置服务模板

| 模板名 | 传输方式 | 功能描述 | 所需环境变量 |
|--------|----------|----------|--------------|
| **memory** | stdio | 内存存储服务 | 无 |
| **filesystem** | stdio | 文件系统访问 | `ALLOWED_DIRECTORY` |
| **brave-search** | stdio | Brave 搜索 API | `BRAVE_API_KEY` |
| **github** | stdio | GitHub API 集成 | `GITHUB_TOKEN` |
| **sqlite** | stdio | SQLite 数据库 | `DATABASE_PATH` |
| **wikipedia** | stdio | Wikipedia 搜索 | 无 |

## 🎨 Web GUI 功能

### 主要页面

1. **仪表板 (Dashboard)** - 系统概览、服务统计、快速操作
2. **服务管理 (Services)** - 服务列表、状态监控、启动/停止控制
3. **模板管理 (Templates)** - 模板库、编辑、导入导出
4. **认证管理 (Authentication)** - Token/API Key 管理
5. **监控中心 (Monitoring)** - 性能指标、实时日志、告警
6. **模板市场 (Catalog)** - 在线模板、搜索、一键安装
7. **MCP 调试 (Console)** - 工具调用、资源管理、调试日志
8. **集成管理 (Integrations)** - 客户端集成配置指南
9. **AI 生成器 (Generator)** - 从文档生成 MCP 配置
10. **智能编排 (Orchestrator)** - 编排器配置和监控
11. **系统设置 (Settings)** - 全局配置、日志设置

### GUI 特性

- 🎨 现代化设计 - Radix UI + Tailwind CSS
- 📱 响应式布局 - 支持各种屏幕尺寸
- ⚡ 实时更新 - WebSocket 实时数据同步
- 🌙 深色模式 - 自动主题切换
- 🔍 智能搜索 - 全局搜索功能
- 📊 数据可视化 - 图表和统计展示

## 🧪 测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- auth

# 查看测试覆盖率
npm run test:coverage

# 类型检查
npm run typecheck

# 代码检查
npm run lint
```

## 🐳 Docker 部署

```bash
# 构建镜像
npm run build:docker

# 或使用 Docker Compose
docker-compose up -d
```

## 📝 开发指南

### 开发模式

```bash
# 开发模式（热重载）
npm run dev

# GUI 开发模式
cd gui && npm run dev
```

### 可用命令

```bash
npm run build          # 构建项目
npm run dev            # 开发模式
npm run gui            # 启动 Web GUI
npm run cli            # 启动 CLI
npm run quick-start    # 快速开始示例
npm test              # 运行测试
npm run typecheck     # 类型检查
npm run lint          # 代码检查
npm run lint:fix      # 修复代码格式
npm run build:docker  # 构建 Docker 镜像
```

## 🔍 监控和调试

### 日志级别

- `trace` - 最详细的日志
- `debug` - 调试信息
- `info` - 一般信息（默认）
- `warn` - 警告信息
- `error` - 错误信息

### 指标监控

- **请求计数** - 总请求数和成功率
- **响应时间** - 平均响应时间和 P95/P99
- **服务健康** - 实时健康检查状态
- **负载分布** - 各服务的负载分布情况

## 🤝 贡献指南

1. Fork 项目
2. 创建特性分支: `git checkout -b feature/amazing-feature`
3. 提交更改: `git commit -m 'Add amazing feature'`
4. 推送分支: `git push origin feature/amazing-feature`
5. 提交 Pull Request

## 📄 许可证

本项目采用 [Apache 2.0 许可证](LICENSE)

## 🙏 致谢

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 规范
- [Fastify](https://www.fastify.io/) Web 框架
- [Vitest](https://vitest.dev/) 测试框架
- [Radix UI](https://www.radix-ui.com/) UI 组件库
- [Tailwind CSS](https://tailwindcss.com/) CSS 框架
- TypeScript 和 Node.js 生态系统

## 📞 支持

如果你遇到问题或需要帮助：

- 📝 [提交 Issue](../../issues)
- 💬 [讨论区](../../discussions)

---

⭐ **如果这个项目对你有帮助，请给一个 Star！**

**PB MCP Gateway - 让 MCP 服务管理变得简单！** 🚀
