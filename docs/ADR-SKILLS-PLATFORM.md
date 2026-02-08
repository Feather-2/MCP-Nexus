# ADR: Skills 平台架构决策记录

> 日期: 2026-02-07
> 状态: Draft
> 范围: Skills 版本管理、安全模型、平台适配、运行时迁移

---

## 1. 项目定位

MCP-Nexus 不是单纯的 MCP 协议网关，而是 **AI Agent 能力供给层**：

- 为纯前端 Web App 提供后端能力支持
- 为 Claude Code、Codex 等第三方 Agent 提供标准化 Skills 管理
- 提供 MCP 工具搜索、沙盒运行时
- 未来开放 Agent SDK

### 不做的事

- 不做 Skills 市场/运营
- 不做声誉评分/排名系统
- 不做社区评价/推荐机制
- 不做多租户（每用户独立实例，可选简单登录）

### 要做的事

- **i18n 国际化**：面向全球用户，支持多语言
- **单用户部署模式**：每个实例服务一个用户/团队，无跨用户数据隔离需求

---

## 1.5 战略定位：平台 + JS Agent 双轮驱动

### 1.5.1 核心战略

本项目是 JS Agent 的延伸，采用"平台 + 自有产品"双轮驱动策略：

```
┌─────────────────────────────────────────────────────────┐
│              Skills 管理平台（新名字待定）               │
├─────────────────────────────────────────────────────────┤
│  服务对象:                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Claude   │  │ Codex    │  │ 其他     │   ← 拉新入口 │
│  │ Code     │  │          │  │ Agent    │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       └─────────────┼─────────────┘                     │
│                     ↓                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │            统一 Skills 服务层                    │   │
│  │  - 版本管理 / 审计 / 沙盒 / Localization        │   │
│  └─────────────────────────────────────────────────┘   │
│                     ↓                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │            JS Agent 核心层                       │   │
│  │  - SDK / 执行运行时 / 深度集成                  │   │ ← 自有产品
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

| 轮子 | 作用 | 价值 |
|------|------|------|
| **开放平台** | 服务 Claude Code/Codex/其他 | 获客、生态、品牌 |
| **JS Agent** | 深度集成、最佳体验 | 转化、留存、商业化 |

### 1.5.2 JS Agent 架构概览

JS Agent 是一个基于微内核架构的 AI Agent 运行时系统（544 文件）：

```
SDK (createAgent/AgentBuilder)
     ↓
Stages (DeepSearch/Design/CodeSearch)
     ↓
Runtime (AgentLoop/Orchestrator/Tools/Hooks)
     ↓
Core (Kernel + 四总线: Event/State/Service/Message)
     ↓
Infrastructure (VFS/LLM/MCP/Retrieval)
```

| 模块 | 文件数 | 职责 |
|------|--------|------|
| stages | 148 | DeepSearch/Design/CodeSearch 业务阶段 |
| runtime | 138 | AgentLoop, Orchestrator, 工具执行 |
| core | 52 | 微内核 + 四总线 + 插件系统 |
| plugins | 38 | 内置插件 |
| vfs | 20 | 虚拟文件系统 (Memory/OPFS/Storage) |
| mcp | 19 | Model Context Protocol |
| llm | 11 | ModelRouter + Provider |
| retrieval | 10 | BM25 + Vector + MMR 混合检索 |

**技术特点**：
- 纯 JS + JSDoc：无 TypeScript 编译，浏览器/Node/Deno/Bun 通用
- 四总线设计：EventBus (Lamport Clock) / StateBus (响应式) / ServiceBus (Retry/Cache) / MessageBus (RPC)
- 插件化：createPlugin() + 预设 (minimal/standard/deepsearch/production)

### 1.5.3 差异化体验

| 功能 | 第三方 Agent | JS Agent |
|------|--------------|----------|
| Skills 管理 | ✅ 完整 | ✅ 完整 |
| 审计/沙盒 | ✅ 完整 | ✅ 完整 |
| Localization | ✅ 适配输出 | ✅ 原生支持 |
| **SDK 深度集成** | ❌ 需自行对接 | ✅ 开箱即用 |
| **执行运行时** | ❌ 自行搭建 | ✅ 内置 |
| **调试/监控** | ❌ 基础 | ✅ 完整 |

JS Agent 用户获得"一等公民"体验，但不限制第三方使用。

### 1.5.4 改名考虑

当前名称 "MCP-Nexus" 需要更改，原因：

1. **品牌热度**：MCP 协议热度下降，名称意义减弱
2. **产品定位**：未来以 Skills 为主体，MCP 是内部实现细节

Skills 的本质：
- 说明书：告诉 AI 怎么做某件事
- 专业知识迁移：把人的 know-how 编码为 AI 可执行的指令
- 可组合能力包：安装即获得新能力

**定位转变**：
```
之前: MCP 协议网关（技术导向）
之后: Skills 管理平台（价值导向）
```

### 1.5.5 竞争分析

**与 Key 管理类产品的关系**：

| 维度 | Key 管理产品 | 本平台 |
|------|--------------|--------|
| 核心能力 | 凭证安全存储/分发 | Skills 审计/版本/沙盒 |
| Skills 定位 | 附加功能 | 核心功能 |
| 安全模型 | 保护 Key 不泄露 | 保护运行时不被滥用 |

潜在协作：他们解决"Key 怎么安全存储"，我们解决"Key 被谁用、用来做什么、是否安全"。

**与 Open Interpreter 类产品的关系**：

| 维度 | Open Interpreter | 本平台 |
|------|------------------|--------|
| 定位 | 通用 AI 执行层 | Skills 管理层 |
| 优势 | 先发、社区 | 审计、安全、多平台 |
| 关系 | 可作为消费方 | 提供 Skills 管理 |

建议：不与执行层产品正面竞争，专注管理 + 安全 + 多平台分发。

### 1.5.6 本项目职责边界

本项目（Skills 平台）是**后端能力供给层**，职责明确：

| 本项目职责 | 上游项目（JS Agent）职责 |
|------------|------------------------|
| Skills 管理（版本/审计/沙盒） | 浏览器端应用 |
| Localization 适配 | AI for Science 场景 |
| MCP 协议支持 | 面向非技术用户的 UX |
| API 服务层 | 执行运行时 |

本项目为 JS Agent 和其他第三方 Agent 提供基础服务，不直接面向终端用户。

---

## 2. Skills 版本管理

### 2.1 设计原则

- **轻量级**：基于 JSON 文件的快照存储，不自建 Git
- **多文件支持**：Skill 可包含 SKILL.md + 代码文件
- **核心功能**：保存、列表、回滚，不需要分支/合并/diff

### 2.2 数据模型

```typescript
interface SkillSnapshot {
  id: string;                          // nanoid(8)
  timestamp: number;
  files: Record<string, string>;       // { "SKILL.md": "...", "lib/helper.ts": "..." }
  reason?: string;                     // "user edit" | "github sync" | "rollback"
}

// 存储: skills-versions/{skillName}.json
// 结构: { current: string, snapshots: SkillSnapshot[] }
```

### 2.3 存储策略

| 场景 | 处理方式 |
|------|----------|
| 文本/代码文件 (<100KB) | 原文存储 |
| 大文件/二进制 | 不纳入版本管理 |
| 版本上限 | 默认保留 10 个快照，自动清理 |

### 2.4 快照触发时机

1. 用户手动保存
2. GitHub 同步后
3. 回滚操作前（自动保存当前状态再回滚）

### 2.5 Skills 来源

| 来源 | 信任级别 | 版本管理 | 审计要求 |
|------|----------|----------|----------|
| 用户上传 | 完全不可信 | 自建快照 | 强制全量审计 |
| GitHub | 部分可信 | 原生 Git | 可利用 commit 签名作为信号 |

---

## 3. 安全模型：四层防御

### 3.1 架构总览

```
L1: 确定性规则 (不会降智)
    ├─ 正则匹配危险模式
    ├─ 能力声明校验
    └─ 结构完整性检查
        ↓
L2: AI 辅助审计 (可能降智，有兜底)
    ├─ AI Decomposer 拆解 Skill 为语义单元
    ├─ 手术刀式审计 Skills 精准分析
    └─ 输出置信度分数
        ↓ 置信度 < 阈值时升级
L3: 人工决策 (最终决定权)
    ├─ 展示权限清单 + AI 审计摘要
    ├─ 用户逐项授权或拒绝
    └─ 默认关闭，人工激活
        ↓
L4: 沙盒能力剥夺 (终极防线)
    ├─ 默认全部拒绝
    ├─ 只允许用户授权的能力
    └─ 运行时强制执行
```

### 3.2 核心原则

| 原则 | 说明 |
|------|------|
| **默认关闭** | Skill 安装后 `enabled: false`，需人工激活 |
| **用户知情** | 展示权限清单 + AI 审计摘要 + 置信度 |
| **最小授权** | 支持逐项授权，不必全部接受 |
| **可撤回** | 用户随时可以禁用或收回权限 |
| **不确定时拒绝** | AI 置信度不足时默认拒绝 |

### 3.3 能力剥夺模型（L4 核心）

```typescript
// 默认配置：全部拒绝
DEFAULT_SKILL_CAPABILITIES = {
  filesystem: { read: [], write: [] },        // 无文件访问
  network: { allowedHosts: [], allowedPorts: [] },  // 无网络
  env: [],                                    // 无环境变量
  subprocess: { allowed: false, allowedCommands: [] },  // 无子进程
  resources: { maxMemoryMB: 512, maxCpuPercent: 50, timeoutMs: 60_000 }
}
```

**关键认知**：与其花大量精力审计代码意图，不如直接限制执行环境的能力。即使审计全部失效，沙盒能力剥夺也能兜底。

### 3.4 AI 审计的降智问题

| 场景 | 后果 | 应对 |
|------|------|------|
| 混淆代码 | AI 看不懂 | 默认拒绝 + 沙盒兜底 |
| 上下文过长 | 关键信息截断 | 拆解为语义单元分析 |
| 对抗性 prompt | 判断被操控 | L0 元认知检测 + 多模型共识 |
| 模型状态波动 | 不确定结果 | 置信度阈值 + 人工升级 |

**结论**：AI 审计是"加分项"而非"必要条件"，真正的安全靠 L3 人工决策 + L4 沙盒能力剥夺。

### 3.5 手术刀式审计 Skills

用 AI 将 Skill 拆解为语义单元，再用专门的审计 Skill 精准分析：

| 审计 Skill | 职责 | 输入 |
|------------|------|------|
| `audit-intent` | 判断工具的真实意图 | tool_definitions |
| `audit-injection` | 检测参数注入风险 | parameter_schemas + code_blocks |
| `audit-dataflow` | 追踪敏感数据流向 | data_flows + external_calls |
| `audit-dependency` | 评估依赖可信度 | imports / package.json |
| `audit-privilege` | 检查权限升级风险 | code_blocks |

### 3.6 审计定位

| 做 | 不做 |
|---|------|
| 安装时审计 | 声誉评分/排名 |
| 权限展示 | 社区评价/评论 |
| 用户授权 | 下载量统计 |
| 沙盒执行 | 推荐/发现机制 |

审计是工具，不是平台。

---

## 4. Skill Localization（平台适配）

### 4.1 背景

同一个 Skill 在不同 Agent 运行时上表现不同。做一层适配是当下的痛点功能。

### 4.2 适配流程

```
Skill 源 (canonical)
    ↓
Localizer (按平台适配)
    ↓
┌────────┐  ┌────────┐  ┌────────┐
│ Claude │  │ Codex  │  │ JS     │
│ Code   │  │        │  │ Agent  │
└────────┘  └────────┘  └────────┘
```

### 4.3 适配维度

| 维度 | 差异点 |
|------|--------|
| 工具声明格式 | Claude: XML-ish, Codex: JSON Schema, 自有: 自定义 |
| Prompt 风格 | Claude 偏好结构化, GPT 偏好自然语言 |
| 上下文窗口 | 影响 Skill 描述的详细程度 |
| 能力边界 | 各平台可用工具不同 |

### 4.4 设计约束

| 做 | 不做 |
|---|------|
| 格式转换 | 重写 Skill 逻辑 |
| Prompt 微调 | 维护独立分支 |
| 从 GitHub 拉取最新适配模板 | 构建复杂的版本矩阵 |
| 标记为"阶段性功能" | 当作永久架构 |

### 4.5 生命周期

这是**过渡期工具**。等各平台的 Skill/Tool 协议趋同（MCP 在推动这件事），Localize 层自然退化为 no-op。设计时保持轻量，方便将来移除。

### 4.6 产品价值

- **实用**：解决当下多平台 Skill 适配的真实痛点
- **获客**：作为差异化卖点吸引用户

---

## 5. Bun 迁移评估

### 5.1 兼容性矩阵

| 依赖 | 兼容性 | 风险 |
|------|--------|------|
| Fastify | 官方支持 | 低 |
| @ai-sdk/* | 纯 JS | 低 |
| @modelcontextprotocol/sdk | 需测试 | 中 |
| **OpenTelemetry** | 已知问题 | **高** |
| pino | 兼容 | 低 |
| ws | 兼容 (Bun 内置更好) | 低 |
| **better-sqlite3** | 原生模块 | **高** |
| ioredis | 兼容 | 低 |

### 5.2 阻塞项

1. **better-sqlite3**：C++ 原生模块 → 替代方案 `bun:sqlite`
2. **OpenTelemetry SDK**：历史兼容问题 → 等待社区修复

### 5.3 迁移策略

- **短期**：保持 Node.js，写兼容代码
- **中期**：等 Bun 生态稳定后全量迁移
- **验证方式**：`bun install && bun test` 看失败数

---

## 6. 待决事项

- [x] 沙盒运行时强制执行层 → 决议：容器沙盒（SandboxPolicy）为硬边界，CapabilityManifest 为审计时参考，不另建运行时逐条拦截层
- [x] Skills 版本管理 → `SkillVersionStore` 已实现
- [x] Localization 首批支持的平台 → Claude Code / Codex / JS Agent / Generic 已实现
- [x] AI 审计 Skills → `AuditDecomposer` + `AuditSkillRouter` + 5 handler 已实现
- [x] 元认知式审计 → 决议：定位为辅助性软标准，持续优化但非决定性；沙盒为硬边界，审计为补充信号
- [x] i18n 方案选型 → 轻量级 JSON locale 文件已实现 (`src/i18n/`)
- [x] i18n 覆盖范围 → 框架已搭建，路由文案迁移待后续

> 详细实现差距见 [GAP-ANALYSIS.md](./GAP-ANALYSIS.md)
