---
name: gh-pr-review
description: MCP-Nexus 代码评审专家。基于 L1/L2/L3 分层评审体系，适配 Vitest 测试、ESLint 规范和 TypeScript strict 模式。
---

# gh-pr-review (MCP-Nexus 代码评审)

## 评审工作流

### 1. Pre-flight 检查

```bash
# 必须全部通过才能进入 L2/L3 评审
npm run lint          # ESLint + @typescript-eslint
npm run typecheck     # tsc --noEmit (strict mode)
npm run test:coverage # vitest --coverage
```

### 2. 多层级审计体系

| 层级 | 关注点 | 自动化程度 |
|------|--------|------------|
| L1 健康度 | ESLint warnings, TypeScript errors | `npm run lint:fix` 可自动修复 |
| L2 逻辑/安全 | 边界条件、async/await 错误处理、注入风险 | 手动审查 |
| L3 架构一致性 | 模块边界、API 契约、MCP 协议兼容性 | 手动审查 |

### 3. 项目特定检查项

**TypeScript 严格模式**:
- 无 `any` 类型泄漏 (`@typescript-eslint/no-explicit-any` 为 warn)
- 正确处理 `null`/`undefined`

**测试覆盖率阈值** (vitest.config.ts):
- Lines: 25%
- Functions: 50%
- Branches: 60%
- 新代码应保持或提升覆盖率

**MCP 协议兼容性**:
- 检查 `@modelcontextprotocol/sdk` 使用是否符合规范
- 验证 tool/resource 定义是否完整

**API 安全**:
- Fastify 路由是否使用 `@fastify/helmet`
- 敏感数据是否使用 `pino` 的 redact 功能

### 4. 交付决策

- **Approve**: 通过所有检查，发表 LGTM
- **Request Changes**: 存在 L2/L3 问题，详细说明修复方案

## 评审命令速查

```bash
# 完整检查流程
npm run lint && npm run typecheck && npm run test:coverage

# 仅检查变更文件 (推荐)
npx eslint --cache $(git diff --name-only HEAD~1 -- '*.ts')
```
