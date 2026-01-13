# Skills Module

Skill 加载、匹配、审计和热重载。

## Files

| File | Description |
|------|-------------|
| `SkillLoader.ts` | Skill 加载器，支持 hash 缓存 |
| `SkillMatcher.ts` | Skill 匹配器 |
| `SkillRegistry.ts` | Skill 注册表，支持热重载 |
| `SkillAuditor.ts` | Skill 审计器 |
| `types.ts` | Skill 类型定义 |
| `index.ts` | 导出 |

## Skill Definition

```typescript
interface Skill {
  name: string;
  description: string;
  triggers: string[];
  handler: SkillHandler;
}
```

## SkillLoader

从文件系统加载 SKILL.md 定义，基于 hash 缓存避免重复解析。

## SkillMatcher

根据用户输入匹配合适的 Skill。

## SkillRegistry

管理已注册的 Skills，支持热重载：

```typescript
// 启动热重载监听
await registry.startWatch();

// 停止监听
registry.stopWatch();

// 手动重载
await registry.reload();
```

热重载特性：
- 监听多个 roots 目录 (深度 5)
- 检测 SKILL.md 变更自动 reload
- 500ms 防抖避免频繁重载
- 单目录监听失败不影响其他目录
