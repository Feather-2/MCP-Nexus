# MCP-Nexus (pb-mcpgateway) 工作进度报告

**日期**: 2026-02-08

---

## 一、Paper-Burner 兼容性适配 (已完成)

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| /api/health 别名 | src/server/HttpApiServer.ts | Done |
| /api/skills/:name/content 扁平响应 | src/server/routes/SkillRoutes.ts | Done |
| /mcp JSON-RPC 端点 | src/server/routes/RoutingRoutes.ts | Done |
| /events + /sse SSE 通知 | src/server/routes/RoutingRoutes.ts | Done |
| server CLAUDE.md 文档更新 | src/server/CLAUDE.md | Done |

**相关 Commits:**

- `cd4568e` - feat: add /api/health alias and /api/skills/:name/content compat route
- `f4d2052` - feat: add generic /mcp JSON-RPC endpoint and /events SSE notifications
- `3f35503` - docs: update server CLAUDE.md with new routes and /api/health alias

---

## 二、安全加固与 SSE 心跳 (已完成)

- /mcp 端点 MCP 方法白名单 (tools/, resources/, prompts/, completion/, logging/, initialize, ping)
- SSE 心跳 30s keepalive 防止代理超时
- +6 测试覆盖白名单拒绝、503 无服务、400 校验、/api/health 别名

**Commit:** `1f53be8` - harden: /mcp method whitelist, SSE heartbeat, +6 tests

---

## 三、测试覆盖率优化 (已完成)

| 模块 | 优化前 | 优化后 | 新增测试文件 |
|------|--------|--------|-------------|
| async.ts | 51% | 100% | src/tests/utils/async.test.ts |
| ToolRoutes.ts | 54% | 92% | src/tests/server/routes/ToolRoutes.test.ts |
| SkillRegistry.ts | 51% | 79% | src/tests/skills/SkillRegistry.coverage.test.ts |
| OrchestratorRoutes.ts | 52% | ~70%+ | src/tests/server/routes/OrchestratorRoutes.coverage.test.ts |

**整体覆盖率:** 81.47% (Lines) / 77% (Branches) / 85.74% (Functions)

**测试数量:** 923 tests, 88 test files, 全部通过

### 3.1 async.ts (51% -> 100%)

**文件:** src/tests/utils/async.test.ts
**覆盖函数:** retry(), withTimeout(), raceWithAbort()

- retry - 首次成功直接返回
- retry - 失败后重试最终成功
- retry - 超过最大重试次数后抛出最后一个错误
- retry - 支持自定义 retries/delay 参数
- withTimeout - 在超时前完成的 promise 正常返回
- withTimeout - 超时后抛出 TimeoutError
- withTimeout - 支持自定义超时消息
- raceWithAbort - 第一个完成的 promise 胜出
- raceWithAbort - 失败时正确传播错误
- raceWithAbort - abort signal 触发时中止

### 3.2 ToolRoutes.ts (54% -> 92%)

**文件:** src/tests/server/routes/ToolRoutes.test.ts
**覆盖端点:** GET /api/tools, POST /api/tools/execute, POST /api/tools/batch, GET /api/tools/history

- GET /api/tools - 返回所有服务的工具列表 (聚合多服务)
- GET /api/tools - 无运行服务时返回空列表
- POST /api/tools/execute - 成功执行工具并返回结果
- POST /api/tools/execute - 缺少 tool 参数返回 400
- POST /api/tools/execute - 服务不存在返回 404
- POST /api/tools/execute - adapter 调用失败返回 500
- POST /api/tools/batch - 批量执行多个工具调用
- POST /api/tools/batch - 部分失败时返回 partial results
- POST /api/tools/batch - 空数组返回 400
- GET /api/tools/history - 返回工具调用历史记录
- GET /api/tools/history - 支持 limit 查询参数

### 3.3 SkillRegistry.ts (51% -> 79%)

**文件:** src/tests/skills/SkillRegistry.coverage.test.ts
**覆盖方法:** register(), delete(), reload(), get(), list(), getManagedRoot(), startWatch(), stopWatch()

- register - 创建新 skill 并写入 SKILL.md 文件
- register - overwrite=true 覆盖已有 skill
- register - overwrite=false 对已有 skill 抛出错误
- register - 写入 supportFiles 到子目录
- register - 路径遍历攻击 (../) 被拒绝
- delete - 删除 managed skill 及其目录
- delete - 非 managed skill 抛出 not managed 错误
- getManagedRoot - 返回配置的管理根目录
- startWatch / stopWatch - 切换 fs.watch 无报错

### 3.4 OrchestratorRoutes.ts (52% -> ~70%+)

**文件:** src/tests/server/routes/OrchestratorRoutes.coverage.test.ts
**覆盖端点:** GET/PUT /api/orchestrator/config, GET/POST/DELETE /api/orchestrator/subagents

- GET /api/orchestrator/status - 无 orchestrator 时返回 disabled
- GET /api/orchestrator/config - 不可用时返回 503
- GET /api/orchestrator/config - 可用时返回配置对象
- PUT /api/orchestrator/config - 不可用时返回 503
- PUT /api/orchestrator/config - 成功更新配置
- GET /api/orchestrator/subagents - disabled 时返回 503
- GET /api/orchestrator/subagents - 列出所有子代理
- POST /api/orchestrator/subagents - 创建子代理 JSON 文件
- POST /api/orchestrator/subagents - 无效配置返回 400
- DELETE /api/orchestrator/subagents/:name - 删除子代理
- DELETE /api/orchestrator/subagents/:name - 不存在返回 404

---

## 四、.gitignore 清理

添加 `/skills` 到 .gitignore，防止测试产生的 skill 文件污染版本控制。

---

## 五、后续可选优化

- RoutingRoutes.ts 分支覆盖率偏低 (31.8%)，SSE handler 难以在单元测试中覆盖
- SkillRegistry.ts watch 相关逻辑 (lines 302-425) 依赖 fs.watch，需集成测试
- GUI 构建 (dist-gui 不存在，GUI 页面返回 503)
- TemplateRoutes/LogRoutes 等中等覆盖率模块的进一步测试

---

## 六、断点续传上下文 (Checkpoint Resume Context)

> 本节为新会话提供完整的断点续传信息。新 Claude 会话读取此文件后即可恢复工作。

### 6.1 项目背景

**项目:** MCP-Nexus (pb-mcpgateway) — TypeScript MCP 协议网关平台
**客户端:** Paper-Burner (pb/paper-burner) — 需要连接 MCP-Nexus 的前端 Agent 系统
**核心目标:** 使 paper-burner 的 `McpNexusProvider` 和 `NexusSkillProvider` 能正确连接 MCP-Nexus

### 6.2 已完成的任务链

1. **Gap 分析** — 对比 paper-burner 客户端期望的 API 与 MCP-Nexus 实际提供的端点
2. **兼容性适配** — 添加 /api/health、/api/skills/:name/content、/mcp、/events、/sse
3. **安全加固** — MCP 方法白名单、SSE 心跳
4. **测试覆盖率优化** — async.ts、ToolRoutes、SkillRegistry、OrchestratorRoutes
5. **文档与 .gitignore 清理**

### 6.3 关键设计决策

| 决策 | 原因 |
|------|------|
| `/mcp` 端点自动选取第一个 running 状态的服务 | paper-burner 不知道具体 serviceId，只发 JSON-RPC |
| `/api/skills/:name/content` 返回扁平 `{body, supportFiles, metadata}` | paper-burner 期望扁平响应，而非 `{success, skill: {...}}` 包裹 |
| MCP 方法白名单用前缀匹配 | 防止内部方法 (如 `__internal/xxx`) 通过 `/mcp` 暴露 |
| SSE heartbeat 30s 间隔 | 防止 nginx/cloudflare 等反向代理断开空闲长连接 |
| SkillRegistry 测试用 mock loader | 真实 SkillLoader 的 `loadAllSkills` 依赖 SKILL.md 完整 frontmatter 格式，单元测试中 mock 更可靠 |

### 6.4 当前 Git 状态

**分支:** main
**最新 commit:** `1f53be8` - harden: /mcp method whitelist, SSE heartbeat, +6 tests

**未提交的变更 (需要 commit):**

| 文件 | 类型 | 描述 |
|------|------|------|
| .gitignore | Modified | 添加 `/skills` 排除测试产物 |
| src/tests/utils/async.test.ts | New | async.ts 全覆盖测试 (10 cases) |
| src/tests/server/routes/ToolRoutes.test.ts | New | ToolRoutes 覆盖测试 (11 cases) |
| src/tests/skills/SkillRegistry.coverage.test.ts | New | SkillRegistry 覆盖测试 (9 cases) |
| src/tests/server/routes/OrchestratorRoutes.coverage.test.ts | New | OrchestratorRoutes CRUD 测试 (11 cases) |
| MCP-Nexus-Progress-Report.md | New | 本进度文档 |

### 6.5 测试验证状态

```
923 tests, 88 test files, 全部通过
覆盖率: 81.47% Lines / 77% Branches / 85.74% Functions
typecheck: clean (tsc --noEmit 无错误)
```

### 6.6 后续待办 (按优先级)

1. **[P1] 提交当前变更** — 将上述未提交文件 commit 到 main
2. **[P2] RoutingRoutes 分支覆盖** — 当前 31.8%，SSE handler 和 middleware chain 分支难测
3. **[P2] SkillRegistry watch 逻辑** — lines 302-425 依赖 fs.watch，需 mock 或集成测试
4. **[P3] GUI 构建** — dist-gui 不存在，GUI 页面返回 503
5. **[P3] 其他中等覆盖率模块** — TemplateRoutes (57%), LogRoutes (59%), ExternalImportRoutes (47%)

### 6.7 关键文件索引

| 文件 | 作用 |
|------|------|
| `src/server/HttpApiServer.ts` | 主 Fastify 服务器，所有路由注册入口 |
| `src/server/routes/RoutingRoutes.ts` | /api/route, /api/proxy/:serviceId, /mcp, /events, /sse |
| `src/server/routes/SkillRoutes.ts` | /api/skills CRUD + /api/skills/:name/content 兼容路由 |
| `src/server/routes/ToolRoutes.ts` | /api/tools 列表、执行、批量、历史 |
| `src/server/routes/OrchestratorRoutes.ts` | /api/orchestrator 状态、配置、子代理 CRUD |
| `src/skills/SkillRegistry.ts` | Skill 注册表，管理加载/注册/删除/监视 |
| `src/utils/async.ts` | retry(), withTimeout(), raceWithAbort() 工具函数 |
| `CLAUDE.md` | 项目根 CLAUDE.md，包含模块索引和命令 |
| `src/server/CLAUDE.md` | 服务器模块文档，路由表 |

### 6.8 Paper-Burner 客户端关键文件

| 文件 | 作用 |
|------|------|
| `/mnt/f/pb/paper-burner/js/agents/mcp/mcp-nexus-provider.js` | 传输发现 (`_discoverTransport`)、资源方法、SSE 订阅 |
| `/mnt/f/pb/paper-burner/js/agents/mcp/nexus-skill-provider.js` | `/api/skills/:name/content` 调用、`streamExecution` SSE |
| `/mnt/f/pb/paper-burner/js/agents/mcp/resource-manager.js` | `listResources`, `readResource` 调用 |

### 6.9 接续指令

新会话启动后，执行以下步骤：

```bash
# 1. 验证测试状态
npm run test
npm run typecheck

# 2. 查看未提交变更
git status
git diff --stat HEAD

# 3. 阅读本文档确认上下文
cat MCP-Nexus-Progress-Report.md

# 4. 继续第五节中的后续优化项
```
