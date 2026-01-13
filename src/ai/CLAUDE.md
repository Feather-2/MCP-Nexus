# AI Module

多模型 AI 客户端，支持负载均衡、成本追踪和限流。

## Files

| File | Description |
|------|-------------|
| `client.ts` | AI 客户端主实现 |
| `channel.ts` | Channel 管理器 |
| `cost-tracker.ts` | 成本追踪 |
| `rate-limiter.ts` | 滑动窗口限流器 |
| `load-balancer.ts` | 负载均衡器 |
| `providers.ts` | Provider 工厂 |
| `types.ts` | 类型定义 |

## Supported Providers

使用 Vercel AI SDK：
- `@ai-sdk/anthropic` - Claude
- `@ai-sdk/openai` - GPT
- `@ai-sdk/google` - Gemini
- `@ai-sdk/mistral` - Mistral
- `@ai-sdk/groq` - Groq
- `@ai-sdk/deepseek` - DeepSeek
- `ollama-ai-provider` - Ollama (本地)

## Key Classes

### AiClient

主客户端，组合多个子系统：
- `ChannelManager` - 多 channel 管理
- `CostTracker` - Token/费用统计
- `SlidingWindowRateLimiter` - 限流
- `LoadBalancer` - channel 选择

支持：
- `generateText()` - 同步生成
- `streamText()` - 流式生成

### ChannelManager

管理多个 AI channel（provider + model 组合）。

### CostTracker

追踪：
- Token 使用量 (input/output)
- 估算费用

## Types

```typescript
interface AiRequest {
  messages: AiMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
}

interface AiResult {
  text: string;
  toolCalls?: AiToolCall[];
  usage: AiUsage;
  finishReason: string;
}
```

## Common Tasks

```typescript
// 同步调用
const result = await client.generate({
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'claude-3-5-sonnet'
});

// 流式调用
for await (const chunk of client.stream(request)) {
  console.log(chunk.text);
}
```
