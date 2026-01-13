# Message Module

消息计数和修剪器。

## Files

| File | Description |
|------|-------------|
| `naive-counter.ts` | 简易消息计数器 |
| `trimmer.ts` | 消息修剪器 |
| `types.ts` | 类型定义 |
| `index.ts` | 导出 |

## Trimmer

控制消息历史长度：
- 基于 token 数限制
- 保留系统消息
- 保留最近 N 条消息
