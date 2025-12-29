# MCP-Nexus 与 Provider 集成指南：高级机制与握手方案

本指南旨在说明如何将 `mcp-nexus` 网关的高级特性（如智能路由、成本跟踪、安全中间件）与 `mcp-nexus-provider.js` 进行深度结合。

## 1. 增强型握手与认证流程 (Handshake Integration)

`mcp-nexus` 提供了比标准 Bearer Token 更安全的 **Local MCP 握手协议**。

### 集成建议：
在 Provider 中实现以下逻辑：
1. **探测阶段**：尝试请求 `/local-proxy/code`。
2. **握手初始化**：若检测到处于本地浏览器环境，调用 `/handshake/init`，并向用户展示网关生成的 6 位验证码。
3. **确认发放**：用户确认后，Provider 调用 `/handshake/confirm` 获取短期 `LocalMCP` Token。

**优势**：无需手动配置 API Key，通过“物理验证码”实现零配置安全连接。

---

## 2. 深度任务分级 (Tiered Routing Integration)

Provider 可以利用网关的 `TierRouter` 来优化 `deepsearch` 的执行路径。

### 结合方式：
- **前置评估**：Provider 在调用工具前，可以先请求网关的路由建议接口（建议扩展一个 `/api/routing/evaluate`）。
- **执行策略**：
    - `direct` 任务：Provider 直接调用特定 Stdio 工具。
    - `skills` 任务：Provider 指定 `serviceId` 调用具备特定领域知识的 MCP 服务。
    - `subagent` 任务：Provider 将整个 Goal 发送给网关的 `OrchestratorEngine`。

---

## 3. 成本与配额同步 (Cost-Aware Provider)

利用网关的 `CostTracker` 实现 Provider 端的预算感知。

### 结合方式：
- **实时余额查询**：Provider 定期查询 `/api/metrics` 中的 `costUsd` 和 `budgetRemaining`。
- **自适应搜索**：如果 `deepsearch` 发现预算接近临界值，Provider 可以自动切换到更廉价的模型或减少搜索深度。

---

## 4. 中间件与插件扩展 (Middleware Hooks)

Provider 的每一次调用都会自动经过网关的中间件管道。

### 结合方式：
- **安全加固 (`SecurityMiddleware`)**：网关已内置参考 `agentsdk-go` 实现的安全中间件：
    - **自动脱敏**：自动识别响应中的 `sk-` 等 API Key 并模糊处理。
    - **路径防护**：通过 `realpath` 解析强制拦截软链接绕过攻击。
    - **参数审计**：禁止 `--no-preserve-root` 等危险参数输入。
- **审计与日志**：利用 `beforeTool` 钩子记录详细的执行轨迹。
- **结果重写**：利用 `afterTool` 钩子对 MCP Server 返回的原始数据进行 Provider 友好的格式化或清洗（例如将复杂的 JSON 自动扁平化）。

---

## 5. 安全沙箱 (Sandbox Integration)

Provider 在执行高危操作（如 `run_command`）时，可以通过 Provider 参数强制网关启用容器隔离。

### 结合方式：
在 `POST /api/tools/execute` 的 `options` 中传递：
```json
{
  "options": {
    "sandbox": "container",
    "containerImage": "mcp-runtime-safe:latest"
  }
}
```

---

## 6. 示例：改进后的集成逻辑

```javascript
// Provider 伪代码示例
async function smartExecute(toolId, params) {
  // 1. 获取路由建议
  const route = await gateway.evaluate(toolId, params);
  
  // 2. 检查成本预算
  if (await gateway.isOverBudget()) {
    throw new Error("Budget exceeded, stopping deepsearch");
  }

  // 3. 执行调用（带自动重试和沙箱控制）
  return await gateway.execute(toolId, params, {
    timeoutMs: route.tier === 'subagent' ? 60000 : 15000,
    sandbox: route.isHighRisk ? 'container' : 'native',
    retries: 3
  });
}
```

通过这种结合，`mcp-nexus-provider` 将从一个简单的“连接器”升级为具备**环境感知**和**自动治理**能力的智能插件。
