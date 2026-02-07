# Skills 平台差距分析报告

> 日期: 2026-02-07
> 基准: ADR-SKILLS-PLATFORM.md
> 状态: 实现完成

---

## 实现状态总览

| 功能模块 | ADR 定义 | 实现状态 | 差距 |
|----------|----------|----------|------|
| **Skills 基础管理** | 加载/匹配/注册 | ✅ 完整 | - |
| **Skills 版本管理** | 快照/回滚 | ✅ 已实现 | `SkillVersionStore` |
| **Localization** | 平台适配 | ✅ 已实现 | `SkillLocalizer` |
| **L1 确定性规则** | HardRuleEngine | ✅ 已实现 | - |
| **L2 AI 审计** | 手术刀式 Skills | ✅ 已实现 | `AuditDecomposer` + 5 handler |
| **L3 人工决策** | 默认关闭+授权 | ✅ 已实现 | `SkillAuthorization` |
| **L4 沙盒能力剥夺** | CapabilityManifest | ✅ 已实现 | - |
| **API 服务层** | REST API | ✅ 完整 | 含授权/版本/适配 API |
| **Auth 认证层** | 简单登录/API Key | ✅ 已实现 | 适配度高 |
| **i18n 国际化** | 多语言支持 | ✅ 已实现 | `src/i18n/` (en/zh) |

---

## 1. Skills 版本管理

**优先级**: P0 (高)
**现状**: ✅ 已实现 (`src/skills/SkillVersionStore.ts`)

### ADR 定义

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

### 缺失功能

| 功能 | 说明 | 预估代码量 |
|------|------|------------|
| `save()` | 创建快照，遍历 Skill 目录序列化 | ~30 行 |
| `list()` | 列出历史版本 | ~10 行 |
| `rollback()` | 回滚到指定版本，反序列化写回 | ~25 行 |
| 存储管理 | `skills-versions/{skillName}.json` | ~15 行 |

### 实现路径

1. 创建 `src/skills/SkillVersionStore.ts`
2. 在 `SkillRegistry` 中集成版本管理
3. 扩展 `SkillRoutes` 添加版本相关 API:
   - `GET /api/skills/{name}/versions` - 列出版本
   - `POST /api/skills/{name}/versions` - 创建快照
   - `POST /api/skills/{name}/rollback/{versionId}` - 回滚

---

## 2. Localization 平台适配

**优先级**: P0 (高)
**现状**: ✅ 已实现 (`src/skills/SkillLocalizer.ts`)

### ADR 定义

支持 Claude Code / Codex / JS Agent 的格式转换和 Prompt 微调：

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

### 适配维度

| 维度 | 差异点 |
|------|--------|
| 工具声明格式 | Claude: XML-ish, Codex: JSON Schema, 自有: 自定义 |
| Prompt 风格 | Claude 偏好结构化, GPT 偏好自然语言 |
| 上下文窗口 | 影响 Skill 描述的详细程度 |
| 能力边界 | 各平台可用工具不同 |

### 缺失功能

| 功能 | 说明 | 预估代码量 |
|------|------|------------|
| `Localizer` 类 | 核心适配逻辑 | ~80 行 |
| 平台检测 | 识别目标平台 | ~20 行 |
| 格式转换器 | 不同平台的格式转换 | ~60 行 |
| Prompt 模板 | 可从 GitHub 拉取 | ~40 行 |

### 实现路径

1. 创建 `src/skills/SkillLocalizer.ts`
2. 定义平台适配接口和内置转换器
3. 扩展 `SkillRoutes` 添加适配 API:
   - `GET /api/skills/{name}/localized?platform=claude-code`

---

## 3. L3 人工决策层

**优先级**: P0 (高)
**现状**: ✅ 已实现 (`src/skills/SkillAuthorization.ts`)

### ADR 定义

```
Skill 安装 → 默认 DISABLED
    ↓
审计流水线 (L1 确定性规则 → L2 AI 辅助)
    ↓
生成《权限报告》展示给用户：
  - 声明的能力（网络、文件、子进程）
  - AI 发现的潜在风险（如有）
  - 风险等级标签（低/中/高）
    ↓
用户决策：
  ☐ 启用（授予全部声明权限）
  ☐ 部分启用（逐项授权）
  ☐ 拒绝
    ↓
启用后 → 沙盒严格执行授权边界
```

### 缺失功能

| 功能 | 说明 | 预估代码量 |
|------|------|------------|
| `Skill.enabled` 字段 | 默认 false | ~10 行 |
| 授权状态持久化 | 存储用户授权决策 | ~30 行 |
| 权限清单 API | 展示 Skill 请求的能力 | ~20 行 |
| 审计摘要 API | 展示 AI 审计结果 | ~20 行 |
| 授权 API | 用户启用/禁用 Skill | ~30 行 |
| 逐项授权 | 部分启用能力 | ~40 行 |

### 实现路径

1. 扩展 `Skill` 类型，添加 `enabled` 和 `authorizedCapabilities` 字段
2. 创建 `src/skills/SkillAuthorization.ts` 管理授权状态
3. 扩展 `SkillRoutes`:
   - `GET /api/skills/{name}/permissions` - 权限清单
   - `GET /api/skills/{name}/audit-summary` - 审计摘要
   - `POST /api/skills/{name}/authorize` - 启用 Skill
   - `POST /api/skills/{name}/revoke` - 禁用 Skill

---

## 4. 手术刀式审计 Skills

**优先级**: P1 (中)
**现状**: ✅ 已实现 (`AuditDecomposer` + `AuditSkillRouter` + 5 个内置 handler)

### ADR 定义

用 AI 将 Skill 拆解为语义单元，再用专门的审计 Skill 精准分析：

| 审计 Skill | 职责 | 输入 |
|------------|------|------|
| `audit-intent` | 判断工具的真实意图 | tool_definitions |
| `audit-injection` | 检测参数注入风险 | parameter_schemas + code_blocks |
| `audit-dataflow` | 追踪敏感数据流向 | data_flows + external_calls |
| `audit-dependency` | 评估依赖可信度 | imports / package.json |
| `audit-privilege` | 检查权限升级风险 | code_blocks |

### 缺失功能

| 功能 | 说明 | 预估代码量 |
|------|------|------------|
| AI Decomposer | 拆解 Skill 为语义单元 | ~100 行 |
| 审计 Skills 定义 | 5 个内置审计 Skills | ~200 行 |
| 审计 Skills 锁定 | 签名/版本锁定机制 | ~50 行 |
| 审计路由器 | 分发到对应审计 Skill | ~50 行 |

### 实现路径

1. 创建 `src/security/AuditDecomposer.ts`
2. 定义内置审计 Skills (`.skills/audit-*/SKILL.md`)
3. 创建 `src/security/AuditSkillRouter.ts`
4. 集成到 `AuditPipeline`

---

## 5. i18n 国际化

**优先级**: P0 (高)
**现状**: ✅ 已实现 (`src/i18n/index.ts` + en.json + zh.json)

### 范围

| 需要 i18n | 不需要 i18n |
|-----------|-------------|
| UI 文案 | Skills 代码 |
| 错误消息 | API 响应结构 |
| 审计报告 | 配置字段名 |
| 文档 | - |

### 实现路径

1. 选择 i18n 方案（推荐轻量级 JSON locale 文件）
2. 抽取现有硬编码文案到 locale 文件
3. 创建 `src/i18n/` 模块
4. 扩展 API 支持 `Accept-Language` header

---

## 6. Auth 认证层评估

**优先级**: 无需改动
**现状**: ✅ 已实现，适配度高

### 现有能力

| 功能 | 实现 | 适配度 |
|------|------|--------|
| 三种认证模式 | `local-trusted` / `external-secure` / `dual` | ✅ `local-trusted` = 简单登录 |
| API Key 管理 | CRUD 完整 | ✅ Agent SDK 对接 |
| Token/Session | 生成/撤销/过期清理 | ✅ 够用 |
| 权限检查 | 通配符 + 映射 | ✅ 够用 |
| 本地信任网络 | 127.0.0.1 + 私有网段 | ✅ 单用户部署核心场景 |
| 导入/导出 | Token + API Key 持久化 | ✅ 便携部署需要 |

### 与"不做多租户"的匹配

- `local-trusted` 模式：本地访问直接全权限，无需登录 — 符合
- `external-secure` 模式：远程访问需 API Key — 符合 Agent SDK 对接
- 无用户注册/多租户隔离 — 符合"不做多租户"

### 关键文件

- `src/auth/AuthenticationLayerImpl.ts` — 636 行，完整实现
- `src/server/routes/AuthRoutes.ts` — 89 行，API 完整

### 小改进项

- `listApiKeys()` 返回完整 API Key，生产环境建议脱敏（低优先级）

**结论**: Auth 层不需要大改，当前实现与"单用户 + 可选登录"定位匹配。

---

## 已实现的亮点

| 组件 | 文件 | 状态 |
|------|------|------|
| SkillRegistry | `src/skills/SkillRegistry.ts` | ✅ 完整，含热重载 |
| SkillAuditor | `src/skills/SkillAuditor.ts` | ✅ 完整 |
| SkillLoader | `src/skills/SkillLoader.ts` | ✅ 完整 |
| SkillMatcher | `src/skills/SkillMatcher.ts` | ✅ 完整 |
| AuditPipeline | `src/security/AuditPipeline.ts` | ✅ 完整 |
| HardRuleEngine | `src/security/HardRuleEngine.ts` | ✅ 完整 |
| RiskScorer | `src/security/RiskScorer.ts` | ✅ 完整 |
| CapabilityManifest | `src/security/CapabilityManifest.ts` | ✅ 完整 |
| SandboxPolicy | `src/security/SandboxPolicy.ts` | ✅ 完整 |
| ContainerTransportAdapter | `src/adapters/ContainerTransportAdapter.ts` | ✅ 完整 |
| EntropyAnalyzer | `src/security/analyzers/EntropyAnalyzer.ts` | ✅ 完整 |
| PermissionAnalyzer | `src/security/analyzers/PermissionAnalyzer.ts` | ✅ 完整 |
| SandboxRoutes | `src/server/routes/SandboxRoutes.ts` | ✅ 完整 |
| SkillVersionStore | `src/skills/SkillVersionStore.ts` | ✅ 完整 |
| SkillAuthorization | `src/skills/SkillAuthorization.ts` | ✅ 完整 |
| SkillLocalizer | `src/skills/SkillLocalizer.ts` | ✅ 完整 |
| AuditDecomposer | `src/security/AuditDecomposer.ts` | ✅ 完整 |
| AuditSkillRouter | `src/security/AuditSkillRouter.ts` | ✅ 完整 |
| i18n | `src/i18n/index.ts` | ✅ 完整 (en/zh) |
| SkillRoutes | `src/server/routes/SkillRoutes.ts` | ✅ 完整 |

---

## 优先级排序

| 优先级 | 功能 | 预估工作量 | 依赖 |
|--------|------|------------|------|
| **P0** | Skills 版本管理 | ~80 行 | 无 |
| **P0** | L3 人工决策层 | ~150 行 | 无 |
| **P0** | Localization 平台适配 | ~200 行 | 无 |
| **P0** | i18n 国际化框架 | ~150 行 | 无 |
| **P1** | 手术刀式审计 Skills | ~400 行 | P0 完成后 |
| **-** | Auth 认证层 | 无需改动 | ✅ 已匹配 |

---

## 下一步行动

1. ~~**立即**: 实现 Skills 版本管理~~ ✅ 已完成
2. ~~**立即**: 搭建 i18n 国际化框架~~ ✅ 已完成
3. ~~**短期**: 实现 L3 人工决策层~~ ✅ 已完成
4. ~~**中期**: 实现 Localization 平台适配~~ ✅ 已完成
5. ~~**后续**: 手术刀式审计 Skills~~ ✅ 已完成
6. **待做**: 路由文案迁移到 i18n（从 AuthRoutes/SkillRoutes 开始）
7. **待做**: API 支持 `Accept-Language` header
8. **待做**: `listApiKeys()` 生产环境脱敏

---

## 相关文档

- [ADR-SKILLS-PLATFORM.md](./ADR-SKILLS-PLATFORM.md) - 架构决策记录
- [ARCHITECTURE.md](./ARCHITECTURE.md) - 整体架构文档
- [SECURITY.md](./SECURITY.md) - 安全模型文档
