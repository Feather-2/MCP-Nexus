# Auth Module

认证层实现。

## Files

| File | Description |
|------|-------------|
| `AuthenticationLayerImpl.ts` | 认证层主实现 |

## Authentication Modes

- `local-trusted` - 本地信任模式，无需认证
- `external-secure` - 外部认证，JWT/API Key
- `dual` - 混合模式

## Key Features

- JWT Token 生成与验证
- API Key 管理
- 权限控制

## Usage

```typescript
const auth = new AuthenticationLayerImpl(config, logger);

// 验证请求
const result = await auth.authenticate(request);
if (!result.authenticated) {
  throw new Error('Unauthorized');
}
```
