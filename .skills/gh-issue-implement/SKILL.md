---
name: gh-issue-implement
description: MCP-Nexus 开发总监。通过 Git Worktree 隔离开发环境，确保代码通过 vitest 测试和 TypeScript 检查后再提交 PR。
---

# gh-issue-implement (MCP-Nexus 开发总监)

## 交付工作流

### 1. 沙盒隔离 (Sandboxing)

```bash
# 创建独立工作区
git worktree add ../pb-mcpgateway-issue-[NUMBER] -b feature/issue-[NUMBER]-[DESC] main
cd ../pb-mcpgateway-issue-[NUMBER]
npm install
```

### 2. 开发规范

**代码风格**:
- TypeScript strict mode
- ESLint + @typescript-eslint 规范
- 使用 `pino` logger，避免 `console.log`

**测试要求**:
- 新功能必须有对应测试文件 (`*.test.ts`)
- 保持覆盖率阈值: lines 25%, functions 50%, branches 60%

**项目结构**:
```
src/
├── core/           # 核心模块
├── config/         # 配置管理
├── routes/         # Fastify 路由
├── services/       # 业务服务
└── *.test.ts       # 测试文件
```

### 3. 提交前验证

```bash
# 必须全部通过
npm run lint        # ESLint 检查
npm run typecheck   # TypeScript 编译检查
npm run test        # Vitest 测试
npm run build       # 确保可构建
```

### 4. PR 提交

```bash
git add .
git commit -m "feat(module): description

Closes #[NUMBER]"

git push -u origin feature/issue-[NUMBER]-[DESC]
gh pr create --title "feat: [description]" --body "Closes #[NUMBER]"
```

### 5. 清理工作区

```bash
cd /mnt/f/pb/pb-mcpgateway
git worktree remove ../pb-mcpgateway-issue-[NUMBER]
git branch -d feature/issue-[NUMBER]-[DESC]  # PR 合并后
```

## 质量自检

- [ ] 是否逐一核对并完成了 Issue 中的所有验收标准？
- [ ] 是否在独立的分支和工作区中完成了工作？
- [ ] 是否通过了 lint + typecheck + test？
- [ ] 是否更新了相关文档（如适用）？
