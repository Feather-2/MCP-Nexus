# Middleware Module

中间件链，包含认证、限流和安全中间件。

## Files

| File | Description |
|------|-------------|
| `chain.ts` | 中间件链实现 |
| `AuthMiddleware.ts` | 认证中间件 |
| `RateLimitMiddleware.ts` | 限流中间件 |
| `SecurityMiddleware.ts` | 安全中间件 |
| `types.ts` | 中间件类型 |
| `index.ts` | 导出 |

## Middleware Chain

责任链模式：
```typescript
chain.use(authMiddleware);
chain.use(rateLimitMiddleware);
chain.use(securityMiddleware);
await chain.execute(context);
```

## Error Types

- `MiddlewareTimeoutError` - 超时
- `MiddlewareAbortedError` - 中止
- `MiddlewareStageError` - 阶段错误

## AuthMiddleware

检查 JWT Token 或 API Key。

## RateLimitMiddleware

基于 IP/用户的限流。

## SecurityMiddleware

安全头检查、XSS 防护等。
