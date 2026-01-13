# Security Module

AI 驱动的安全审计系统，包含行为验证和 Canary 测试。

## Files

| File | Description |
|------|-------------|
| `AiAuditor.ts` | AI 审计器，分析请求风险 |
| `AuditExplainer.ts` | 审计结果解释器 |
| `AuditPipeline.ts` | 审计流水线 |
| `AuditResultCache.ts` | 审计结果缓存 |
| `BehaviorValidator.ts` | 行为验证器 |
| `CanarySystem.ts` | Canary 部署测试 |
| `CapabilityManifest.ts` | 能力清单管理 |
| `ExecutableResolver.ts` | 可执行文件解析 |
| `SandboxPolicy.ts` | Sandbox 策略归一化与模板约束（portable/container） |

## Sandbox Policy

`SandboxPolicy.ts` 负责将 `GatewayConfig` 中的安全配置规范化为 `NormalizedSandboxPolicy`，并提供容器运行时的默认加固参数：
- `defaultPidsLimit` - 默认 PID 限制（可选）
- `defaultNoNewPrivileges` - 默认启用 `no-new-privileges`（默认 true）
- `defaultDropCapabilities` - 默认 drop 的 Linux capabilities 列表

## Key Types

### AiAuditResult

```typescript
interface AiAuditResult {
  riskLevel: 'safe' | 'suspicious' | 'malicious';
  confidence: number; // 0-1
  findings: AiFinding[];
  recommendation: 'approve' | 'review' | 'reject';
  explanation: string;
}
```

### AiFinding

```typescript
interface AiFinding {
  category: AiFindingCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: string;
  reasoning: string;
}
```

### Categories

- `intent_consistency` - 意图一致性
- `obfuscation` - 混淆检测
- `data_exfiltration` - 数据泄露
- `credential_access` - 凭证访问
- `social_engineering` - 社会工程
- `excessive_privileges` - 过度权限
- `supply_chain` - 供应链风险

## Signal Config

风险等级权重配置：
- `safe` - 权重低
- `suspicious` - 权重 0.3-0.5
- `malicious` - 权重高，负面影响大

## Common Tasks

```typescript
// 审计请求
const result = await auditor.audit({
  skill: skillDef,
  request: mcpRequest
});

// 检查是否需要人工审核
if (result.recommendation === 'review') {
  // 需要人工确认
}
```
