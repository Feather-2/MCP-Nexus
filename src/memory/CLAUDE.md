# Memory Module

内存存储和向量存储。

## Structure

```
memory/
├── MemoryStore.ts   # 内存 KV 存储
├── factory.ts       # 存储工厂
├── index.ts
└── vector/          # 向量存储
```

## MemoryStore

简易内存 KV 存储：
- `get(key)` - 获取
- `set(key, value, ttl?)` - 设置
- `delete(key)` - 删除
- TTL 支持

## Vector Store

向量数据库接口，支持：
- 向量相似度搜索
- 文档嵌入存储
