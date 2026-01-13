# Events Module

事件总线和去重器。

## Files

| File | Description |
|------|-------------|
| `bus.ts` | 事件总线 |
| `deduper.ts` | 事件去重器 |
| `types.ts` | 事件类型定义 |
| `index.ts` | 导出 |

## Event Bus

发布-订阅模式：
- `emit(event, data)` - 发布事件
- `on(event, handler)` - 订阅事件
- `off(event, handler)` - 取消订阅

## Deduper

防止重复事件处理，基于事件 ID 去重。
