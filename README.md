# Paper Burner MCP Gateway

🚀 **一个功能完整的 TypeScript MCP 协议网关平台**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)]()

Paper Burner MCP Gateway 是一个生产就绪的 Model Context Protocol (MCP) 网关实现，支持多种传输方式、智能路由、负载均衡和完整的服务管理功能。

## 📚 文档位置

- 实现指南：`docs/IMPLEMENTATION_GUIDE.md` — 架构、协议适配（stdio/http/streamable-http）、鉴权（local-trusted/external-secure/dual）、路由与代理、日志监控（SSE）、本地 MCP Proxy 双阶段握手、模板与 Sandbox 安装流程、端点清单。
- 客户端接入：`docs/CLIENT_INTEGRATIONS.md` — 各客户端接入方式与差异（Claude、Cursor、Cline、Windsurf、VS Code），包含认证头、URL 与常见问题；并说明浏览器侧采用本地 MCP Proxy 的场景。
- 实时状态：`STATUS.md` — 当前测试通过率与失败用例摘要（权威口径）。
 - 编排设计：`docs/ORCHESTRATOR_DESIGN.md` — Orchestrator/Wrapper 方案（Planner/Subagent/Memory/向量检索/预算/并发池/回退），默认关闭，混合/灰度可选。
 - 架构图与时序图：`docs/ARCHITECTURE.md` — Mermaid 架构图、典型调用链与时序图（选路、代理、本地 MCP Proxy）。

## ✨ 特性亮点

- 🔄 **多传输协议支持** - Stdio, HTTP, Streamable HTTP
- 🛡️ **完整认证系统** - Token/API Key 管理，多种认证模式
- 🧠 **智能路由** - 性能优化、成本优化、内容感知路由
- ⚖️ **负载均衡** - 多种负载均衡策略
- 📊 **监控指标** - 完整的健康检查和性能监控
- 🔧 **配置管理** - 灵活的配置系统和模板管理
- 🖥️ **CLI 工具** - 友好的命令行界面
- 🌐 **HTTP API** - RESTful API 接口
- 🎨 **Web GUI** - 现代化的 Web 管理界面
- 📝 **TypeScript** - 完整的类型安全

## 🚀 快速开始

### 安装依赖

```bash
git clone <your-repo>
cd pb-mcpgateway
npm install
```

### 构建项目

```bash
npm run build
```

### 启动 Web GUI

```bash
npm run gui
```

在浏览器中访问：http://localhost:19233

**Web GUI 功能：**
- 📊 实时监控仪表板
- 🛠️ 服务管理界面
- 📋 模板配置管理
- 🔐 认证设置界面
- 📈 性能指标图表
- ⚙️ 系统配置面板
- 🧠 Orchestrator 编排层状态卡片

### 启动 CLI

```bash
npm run cli
```

在 CLI 中使用以下命令：

```bash
pb-mcp> start    # 启动网关
pb-mcp> status   # 查看状态
pb-mcp> help     # 显示帮助
pb-mcp> stop     # 停止网关
pb-mcp> exit     # 退出
```

### 编程方式使用

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
  const serviceId = await gateway.createService('filesystem', {
    env: { ALLOWED_DIRECTORY: '/tmp' }
  });

  // 查看服务状态
  const services = await gateway.listServices();
  console.log('运行中的服务:', services.length);

  // 停止网关
  await gateway.stop();
}
```

## 📋 可用命令

### 开发命令

```bash
npm run build         # 构建项目
npm run dev          # 开发模式（热重载）
npm run gui          # 启动 Web GUI 界面
npm run cli          # 启动 CLI
npm test            # 运行测试
npm run typecheck   # 类型检查
npm run lint        # 代码检查
npm run lint:fix    # 修复代码格式
npm run demo        # 运行交互式演示
```

## 🏗️ 架构概览

### 核心组件

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   HTTP API      │    │   CLI Interface  │    │   Web GUI       │
│   Server        │    │                  │    │   Dashboard     │
└─────────┬───────┘    └────────┬─────────┘    └─────────┬───────┘
          │                     │                        │
          └─────────────────────┼────────────────────────┘
                                │
          ┌─────────────────────┴────────────────────────┐
          │              PbMcpGateway                   │
          └─────────────────────┬────────────────────────┘
                                │
    ┌───────────┬─────────┬─────┴─────┬──────────┬─────────────┐
    │           │         │           │          │             │
┌───▼───┐ ┌────▼────┐ ┌──▼──┐ ┌─────▼─────┐ ┌──▼──┐ ┌───────▼────┐
│ Auth  │ │ Router  │ │ Reg │ │ Adapters  │ │ Cfg │ │ Templates  │
│ Layer │ │         │ │     │ │           │ │ Mgr │ │            │
└───────┘ └─────────┘ └─────┘ └───────────┘ └─────┘ └────────────┘
```

### 支持的传输方式

- **Stdio** - 标准输入输出通信
- **HTTP** - HTTP 请求响应模式
- **Streamable HTTP** - 基于 Server-Sent Events 的流式通信

## 🔧 配置选项

### 基础配置

```json
{
  "port": 19233,
  "host": "127.0.0.1",
  "authMode": "local-trusted",
  "routingStrategy": "performance",
  "loadBalancingStrategy": "performance-based",
  "maxConcurrentServices": 50,
  "enableMetrics": true,
  "logLevel": "info"
}
```

### 认证模式

- **local-trusted** - 本地网络自动信任
- **external-secure** - 需要 Token/API Key
- **dual** - 本地信任 + 外部认证

### 负载均衡策略

- **round-robin** - 轮询分配
- **performance-based** - 基于性能指标
- **cost-optimized** - 成本优化
- **content-aware** - 内容感知路由

## 🎯 内置服务模板

| 模板名 | 传输方式 | 功能描述 | 所需环境变量 |
|--------|----------|----------|--------------|
| **filesystem** | stdio | 文件系统访问 | `ALLOWED_DIRECTORY` |
| **brave-search** | stdio | Brave 搜索 API | `BRAVE_API_KEY` |
| **github** | stdio | GitHub API 集成 | `GITHUB_TOKEN` |
| **sqlite** | stdio | SQLite 数据库 | `DATABASE_PATH` |
| **memory** | stdio | 内存存储服务 | 无 |

## 🌐 HTTP API 接口

### 健康检查

```bash
GET /health
```

### 服务管理

```bash
GET    /api/services           # 列出所有服务
POST   /api/services           # 创建服务实例
GET    /api/services/:id       # 获取服务详情
DELETE /api/services/:id       # 停止服务
GET    /api/services/:id/health # 检查服务健康状态
```

### 模板管理

```bash
GET    /api/templates          # 列出可用模板
POST   /api/templates          # 注册新模板
DELETE /api/templates/:name    # 删除模板
```

### 认证管理

```bash
POST   /api/auth/token         # 生成访问 Token
POST   /api/auth/apikey        # 创建 API Key
DELETE /api/auth/token/:token  # 撤销 Token
DELETE /api/auth/apikey/:key   # 撤销 API Key
```

### 监控指标

```bash
GET /api/metrics              # 获取系统指标
GET /api/health-status        # 详细健康状态
```

## 💻 使用示例

### 1. 创建文件系统服务

```bash
curl -X POST http://localhost:19233/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "templateName": "filesystem",
    "instanceArgs": {
      "env": {"ALLOWED_DIRECTORY": "/tmp"}
    }
  }'
```

### 2. 生成认证 Token

```bash
curl -X POST http://localhost:19233/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "permissions": ["read", "write"],
    "expiresInHours": 24
  }'
```

### 3. 查看系统状态

```bash
curl http://localhost:19233/api/health-status
```

## 🎨 Web GUI 界面

### GUI 功能概览

Paper Burner MCP Gateway 采用 **GitHub Primer Design System**，提供了一个简洁、专业的 Web 管理界面，专为开发者设计的现代化管理体验。

### 主要界面模块

#### 1. 🏠 仪表板 (Dashboard)
- **状态概览卡片** - 系统健康状态和服务统计
- **快速操作面板** - 创建服务的快速入口
- **系统指标** - 实时展示服务状态和性能数据

#### 2. 📦 服务管理 (Services)
- **服务列表视图** - 所有运行中的MCP服务
- **服务状态监控** - 实时健康检查
- **操作控制** - 启动/停止/重启服务

#### 3. 📋 模板管理 (Templates)
- **模板库** - 已保存的服务模板
- **模板编辑** - 添加/编辑/删除模板
- **导入导出** - 模板的备份和分享

#### 4. 🔐 认证管理 (Authentication)
- **API密钥** - 创建和管理访问密钥
- **Token管理** - JWT Token的生成和撤销
- **权限控制** - 基于角色的访问控制

#### 5. 📈 系统监控 (Monitoring)
- **性能指标** - 系统负载和响应时间
- **实时日志** - 服务运行日志查看
- **告警通知** - 异常状态提醒

#### 6. 📦 模板市场 (Catalog)
- **在线模板** - 可用的MCP服务模板
- **搜索过滤** - 按功能/传输方式筛选
- **一键安装** - 快速部署模板到本地

#### 7. 🔌 MCP调试 (Console)
- **工具调用** - 直接调用MCP工具
- **资源管理** - 读取和操作资源
- **调试信息** - 详细的请求/响应日志

#### 8. 🔗 集成管理 (Integrations)
- **客户端集成** - 多客户端配置指南
- **Local MCP Proxy** - 本地代理配对
- **连接测试** - 验证集成配置

#### 9. ✨ AI生成器 (Generator)
- **智能生成** - 基于Markdown生成MCP配置
- **模板预览** - 实时预览生成结果
- **自动部署** - 一键注册到模板库

#### 10. 🎯 智能编排 (Orchestrator)
- **架构可视化** - 三层架构展示
- **子代理管理** - 子代理配置和监控
- **路由配置** - 智能路由策略
- **预算控制** - 资源使用限制
- **性能监控** - 编排层性能指标

#### 11. ⚙️ 系统设置 (Settings)
- **全局配置** - 系统级参数设置
- **日志配置** - 日志级别和输出
- **安全设置** - 认证和授权配置

### 启动 GUI

```bash
# 构建项目
npm run build

# 启动带 GUI 的网关
npm run gui
```

打开浏览器访问：**http://localhost:19233**

### GUI 特性

- **🎨 现代设计** - 采用现代化的UI组件库
- **📱 响应式布局** - 支持桌面和移动设备访问
- **⚡ 实时更新** - WebSocket连接实现数据实时刷新
- **🌙 深色模式** - 支持GitHub风格的亮色/深色主题
- **🔍 智能搜索** - 全局搜索服务和配置
- **📊 数据可视化** - 简洁的图表和统计展示
- **🎯 功能完整** - 11个功能页面覆盖所有需求
- **🔐 安全访问** - 基于网关认证系统的安全控制

### 使用场景

1. **开发调试** - 快速创建测试服务，查看实时日志
2. **生产监控** - 监控服务健康状态，及时发现问题
3. **配置管理** - 可视化配置管理，避免手工错误
4. **团队协作** - 团队成员通过 Web 界面协同管理

## 🧪 测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- auth

# 查看测试覆盖率
npm run test:coverage
```

**测试状态：**
- ✅ TypeScript 编译：100% 通过
- ✅ 核心功能：200/271 测试通过
- 🔄 部分运行时测试需要调优

## 📁 项目结构

```
pb-mcpgateway/
├── src/
│   ├── auth/                 # 认证系统
│   ├── config/               # 配置管理
│   ├── gateway/              # 服务注册
│   ├── router/               # 路由系统
│   ├── adapters/             # 传输适配器
│   ├── server/               # HTTP 服务器
│   ├── types/                # 类型定义
│   ├── utils/                # 工具函数
│   └── tests/                # 测试文件
├── dist/                     # 编译输出
├── config/                   # 配置文件
└── templates/                # 服务模板
```

## 🔍 监控和调试

### 日志级别

```typescript
{
  "logLevel": "trace" | "debug" | "info" | "warn" | "error"
}
```

### 指标监控

- **请求计数** - 总请求数和成功率
- **响应时间** - 平均响应时间
- **服务健康** - 实时健康检查
- **负载分布** - 服务负载分布情况

## 🚧 开发状态

### ✅ 已完成

- [x] **TypeScript 类型系统** - 完整类型安全
- [x] **核心网关功能** - 服务管理和路由
- [x] **认证授权系统** - Token/API Key 管理
- [x] **传输适配器** - 三种传输方式
- [x] **HTTP API 服务器** - RESTful 接口
- [x] **CLI 工具** - 命令行管理界面
- [x] **配置管理系统** - 灵活配置
- [x] **监控指标** - 健康检查和性能监控
- [x] **Web GUI 界面** - GitHub Primer Design System 风格

### 🔄 持续改进

- [ ] 单元测试覆盖率提升
- [ ] 集成测试完善
- [ ] 性能优化调优
- [ ] 错误处理增强
- [ ] GUI 交互体验优化

### 🎯 未来规划

- [ ] **GitHub Integration** - 与 GitHub Actions 集成
- [ ] **VS Code Extension** - VS Code 插件支持
- [ ] **集群部署支持** - 多实例负载均衡
- [ ] **服务发现机制** - 自动服务注册发现
- [ ] **高级监控** - Prometheus/Grafana 集成
- [ ] **Docker 容器化** - 容器化部署
- [ ] **Kubernetes 支持** - K8s Operator
- [ ] **插件系统** - 可扩展的插件架构

## 🤝 贡献指南

1. Fork 项目
2. 创建特性分支: `git checkout -b feature/amazing-feature`
3. 提交更改: `git commit -m 'Add amazing feature'`
4. 推送分支: `git push origin feature/amazing-feature`
5. 提交 Pull Request

## 🗣️ 沟通与语言

请参考《agents.md》了解与用户沟通的语言约定与协作准则：

- 默认与用户使用中文（简体）交流；
- 如用户指定其他语言或格式，请遵从其要求；
- 终端提示与计划更新同样使用中文，保持简洁清晰。

详见 `agents.md`。

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)

## 🙏 致谢

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 规范
- [Fastify](https://www.fastify.io/) Web 框架
- [Vitest](https://vitest.dev/) 测试框架
- [GitHub Primer Design System](https://primer.style/) UI 设计系统
- TypeScript 和 Node.js 生态系统

## 📞 支持

如果你遇到问题或需要帮助：

- 📝 [提交 Issue](../../issues)
- 📧 Email: your-email@example.com
- 💬 [讨论区](../../discussions)

---

⭐ **如果这个项目对你有帮助，请给一个 Star！**

**Paper Burner MCP Gateway - 让 MCP 服务管理变得简单！** 🚀
