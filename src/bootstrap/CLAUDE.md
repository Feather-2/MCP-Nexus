# Bootstrap Module

依赖注入容器和网关启动器。

## Files

| File | Description |
|------|-------------|
| `Container.ts` | DI 容器 |
| `GatewayBootstrapper.ts` | 网关启动流程 |

## Container

简易依赖注入容器：
- `register(name, factory)` - 注册服务
- `resolve(name)` - 解析服务
- 支持单例模式

## GatewayBootstrapper

启动流程：
1. 加载配置
2. 初始化 Logger
3. 创建 ServiceRegistry
4. 创建 Router
5. 启动 HttpApiServer
6. 注册默认服务模板
